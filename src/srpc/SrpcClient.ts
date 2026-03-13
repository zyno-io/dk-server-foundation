import { LoggerInterface } from '@deepkit/logger';
import { createHmac } from 'crypto';
import { once } from 'lodash';
import WebSocket from 'ws';

import { getAppConfig } from '../app/resolver';
import { uuid7 } from '../helpers';
import { withLoggerContext } from '../services';
import { getTraceContext, withRemoteSpan, withSpan } from '../telemetry';
import { SrpcByteStream } from './SrpcByteStream';
import {
    BaseMessage,
    HandlerRequestData,
    InvokePrefixes,
    IQueuedRequest,
    RequestData,
    RequestKeys,
    ResponseData,
    SrpcDisconnectCause,
    SrpcMessageFns,
    SrpcMeta
} from './types';

export class SrpcConflictError extends Error {
    constructor() {
        super('Connection rejected: client ID already connected');
        this.name = 'SrpcConflictError';
    }
}

export interface SrpcClientOptions {
    enableReconnect?: boolean;
    /** SRPC protocol version. v2 requires explicit _supersede=1 to kick existing connections. Default: 2. */
    protocolVersion?: number;
}

export class SrpcClient<TClientInput extends BaseMessage = BaseMessage, TServerOutput extends BaseMessage = BaseMessage> {
    private ws?: WebSocket;
    private outboundType: SrpcMessageFns<TClientInput>;
    private inboundType: SrpcMessageFns<TServerOutput>;
    private streamConnectionHandlers = new Set<() => void>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private streamMessageHandlers = new Map<RequestKeys<TServerOutput>, { resultType: string; handler: (data: any) => Promise<any> }>();
    private streamDisconnectionHandlers = new Set<(cause: SrpcDisconnectCause) => void>();
    private reconnectionTimeout?: NodeJS.Timeout;
    private pingInterval?: NodeJS.Timeout;
    private lastPongMs?: number;
    private requestQueue = new Map<string, IQueuedRequest>();
    private connectResolve?: () => void;
    private connectReject?: (err: Error) => void;
    private enableReconnect: boolean;
    private protocolVersion: number;
    private intentionalDisconnect = false;
    private supersede = false;
    private streamId = '';

    public isConnected = false;

    constructor(
        private logger: LoggerInterface,
        private uri: string,
        /** ts-proto generated ClientMessage type with encode/decode */
        clientMessage: SrpcMessageFns<TClientInput>,
        /** ts-proto generated ServerMessage type with encode/decode */
        serverMessage: SrpcMessageFns<TServerOutput>,
        private clientId: string,
        private clientMeta?: SrpcMeta,
        private clientSecret?: string,
        clientOptions?: SrpcClientOptions
    ) {
        this.enableReconnect = clientOptions?.enableReconnect !== false;
        this.protocolVersion = clientOptions?.protocolVersion ?? 2;
        this.outboundType = clientMessage;
        this.inboundType = serverMessage;
    }

    ////////////////////////////////////////
    // Connection Management

    connect(options?: { supersede?: boolean }): Promise<void> {
        if (this.reconnectionTimeout) {
            clearTimeout(this.reconnectionTimeout);
            this.reconnectionTimeout = undefined;
        }

        // Reject any pending connect promise from a previous call
        this.connectReject?.(new Error('Connection superseded by new connect() call'));
        this.connectResolve = undefined;
        this.connectReject = undefined;

        if (this.ws) {
            this.intentionalDisconnect = true;
            this.ws.close();
            this.ws = undefined;
        }

        this.intentionalDisconnect = false;
        this.supersede = options?.supersede ?? false;
        this.logger.info('Connecting...');

        this.streamId = uuid7();
        this.byteStream.parentStreamId = this.streamId;

        SrpcByteStream.init(this, { startId: 1, step: 2 });

        const wsUrl = this.generateWsUrl();
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'nodebuffer';

        const connectTimeout = setTimeout(() => {
            this.logger.warn('Connection timeout');
            this.connectReject?.(new Error('Connection failed: timeout'));
            this.connectResolve = undefined;
            this.connectReject = undefined;
            ws.close();
            this.queueReconnect();
        }, 10_000);
        const clearConnectTimeout = once(() => clearTimeout(connectTimeout));

        ws.once('open', () => {
            if (this.ws !== ws) return;
            this.logger.debug('WebSocket connection opened, waiting for server ping');
        });

        ws.once('message', (data: Buffer) => this.handleInitialHandshake(ws, data, clearConnectTimeout));
        ws.on('close', (code, reason) => this.handleClose(ws, code, reason, clearConnectTimeout));
        ws.on('error', (err: Error) => this.handleError(ws, err, clearConnectTimeout));

        this.ws = ws;

        const promise = new Promise<void>((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
        });
        // Attach a no-op catch so fire-and-forget callers don't trigger
        // unhandled rejection warnings. The original promise still rejects
        // normally for callers who await it.
        promise.catch(() => {});
        return promise;
    }

    disconnect() {
        this.enableReconnect = false;
        this.intentionalDisconnect = true;

        if (this.reconnectionTimeout) {
            clearTimeout(this.reconnectionTimeout);
            this.reconnectionTimeout = undefined;
        }

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }

        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
        }
    }

    /**
     * Trigger an immediate connection health check.
     * Sends a ping and expects a pong before the next scheduled ping interval,
     * otherwise the connection will be reset due to pong timeout.
     */
    triggerConnectionCheck() {
        if (!this.isConnected) return;

        this.logger.debug('Triggering connection check');
        this.lastPongMs = Date.now() - 20_000;
        this.writeMessage({ pingPong: {} });
    }

    ////////////////////////////////////////
    // Connection Handlers

    private handleInitialHandshake(ws: WebSocket, data: Buffer, clearConnectTimeout: () => void) {
        if (this.ws !== ws) return;

        clearConnectTimeout();

        const message = this.decodeMessage(data);
        if (!message) {
            this.logger.warn('Failed to decode initial message');
            ws.close();
            return;
        }

        if (!message.pingPong) {
            this.logger.warn('Expected pingPong as first message, got:', message);
            ws.close();
            return;
        }

        this.lastPongMs = Date.now();
        this.writeMessage({ pingPong: {} });

        this.logger.info('Stream established');
        this.isConnected = true;
        this.pingInterval = setInterval(() => this.doPingPong(), 55_000);

        this.connectResolve?.();
        this.connectResolve = undefined;
        this.connectReject = undefined;

        this.streamConnectionHandlers.forEach(handler => handler());

        ws.on('message', async (msgData: Buffer) => this.handleMessage(msgData));
    }

    private handleClose(ws: WebSocket, code: number, reason: Buffer | string, clearConnectTimeout: () => void) {
        if (ws !== this.ws) return;
        clearConnectTimeout();

        const reasonStr = String(reason);
        const cause = this.parseDisconnectCause(code, reasonStr);

        if (this.intentionalDisconnect) {
            this.logger.debug('WebSocket closed by client');
        } else if (cause === 'conflict') {
            this.logger.warn('Connection rejected: client ID already connected on server');
            this.connectReject?.(new SrpcConflictError());
            this.connectResolve = undefined;
            this.connectReject = undefined;
            this.handleDisconnect(cause, true);
            return;
        } else {
            this.logger.info('Stream ended', { code, reason: reasonStr });
        }

        this.handleDisconnect(cause);
    }

    private parseDisconnectCause(code: number, reason: string): SrpcDisconnectCause {
        if (code === 4000) {
            if (reason.includes('already connected')) return 'conflict';
            if (reason.includes('cause: duplicate')) return 'duplicate';
            if (reason.includes('cause: timeout')) return 'timeout';
            return 'badArg';
        }
        return 'disconnect';
    }

    private handleError(ws: WebSocket, err: Error, clearConnectTimeout: () => void) {
        if (ws !== this.ws) return;
        clearConnectTimeout();

        if (!this.intentionalDisconnect) {
            this.logger.warn('WebSocket error', err);
        }

        ws.terminate();
        this.handleDisconnect('disconnect');
    }

    private handleDisconnect(cause: SrpcDisconnectCause = 'disconnect', suppressReconnect = false) {
        if (this.reconnectionTimeout) {
            return;
        }

        if (this.enableReconnect && !suppressReconnect) {
            this.queueReconnect();
        }

        clearInterval(this.pingInterval!);
        this.pingInterval = undefined;

        this.connectReject?.(new Error(`Connection failed: ${cause}`));
        this.connectResolve = undefined;
        this.connectReject = undefined;

        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.ws = undefined;

        if (wasConnected) {
            this.streamDisconnectionHandlers.forEach(handler => handler(cause));
        }

        for (const queueItem of this.requestQueue.values()) {
            queueItem.reject(new Error('Disconnected'));
        }
        this.requestQueue.clear();
    }

    private queueReconnect() {
        if (!this.enableReconnect) {
            return;
        }

        this.reconnectionTimeout = setTimeout(() => {
            this.reconnectionTimeout = undefined;
            this.connect();
        }, 1000);
    }

    private doPingPong() {
        if ((this.lastPongMs ?? 0) < Date.now() - 75_000) {
            this.logger.warn('Pong timeout');
            this.ws?.close(4001, 'Pong timeout');
            return;
        }

        this.writeMessage({ pingPong: {} });
    }

    ////////////////////////////////////////
    // Message Handling

    private async handleMessage(data: Buffer) {
        const message = this.decodeMessage(data);
        if (!message) {
            this.logger.warn('Failed to decode message');
            return;
        }

        if (message.pingPong) {
            this.lastPongMs = Date.now();
            return;
        }

        if (message.byteStreamOperation) {
            return this.handleByteStreamOperation(message.byteStreamOperation);
        }

        const { requestId, reply } = message;

        this.logger.debug('Server message received', { requestId, reply, error: !!message.error });

        if (!requestId) {
            this.logger.warn('Protocol error: missing request ID, terminating connection');
            this.ws?.close(4002, 'Invalid request ID');
            return;
        }

        if (reply) {
            return this.handleReply(requestId, message);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.handleServerRequest(requestId, message as any);
    }

    private handleByteStreamOperation(op: NonNullable<TServerOutput['byteStreamOperation']>) {
        if (op.write) {
            return SrpcByteStream.writeReceiver(this, op.streamId, op.write.chunk);
        }

        if (op.finish) {
            return SrpcByteStream.finishReceiver(this, op.streamId);
        }

        if (op.destroy) {
            return SrpcByteStream.destroySubstream(this, op.streamId, op.destroy.error);
        }
    }

    private handleReply(requestId: string, message: TServerOutput & BaseMessage) {
        const queueItem = this.requestQueue.get(requestId);
        if (!queueItem) {
            this.logger.warn('Protocol error: unknown request ID for reply, terminating connection', { requestId });
            this.ws?.close(4003, 'Unknown request ID');
            return;
        }

        this.requestQueue.delete(requestId);
        if (message.error) {
            return queueItem.reject(message.error);
        }
        return queueItem.resolve(message);
    }

    private async handleServerRequest(requestId: string, message: TServerOutput & BaseMessage): Promise<void> {
        for (const key of this.streamMessageHandlers.keys()) {
            if (message[key as keyof TServerOutput]) {
                const logMeta = { requestId, requestType: key, traceId: message.trace?.traceId };
                const response = await withRemoteSpan('srpc:handleServerRequest', message.trace, { requestId, requestType: key }, () =>
                    withLoggerContext({ srpc: logMeta }, async () => {
                        try {
                            this.logger.info('Server request received');
                            const handlerMeta = this.streamMessageHandlers.get(key)!;
                            const result = await handlerMeta.handler(message[key as keyof TServerOutput]);
                            this.logger.info('Server request processed');
                            return {
                                [handlerMeta.resultType]: result
                            } as Partial<TClientInput>;
                        } catch (err) {
                            this.logger.warn('Server request failed', err);
                            throw err;
                        }
                    })
                );
                this.writeMessage({ requestId, reply: true, ...response } as BaseMessage);
                return;
            }
        }

        this.logger.error('Unhandled message type', { requestId });
        this.writeMessage({ requestId, reply: true, error: 'Unhandled message type' } as BaseMessage);
    }

    ////////////////////////////////////////
    // Protocol Helpers

    private generateWsUrl(): string {
        const authv = 1;
        const appv = '0.0.0'; // todo: autodetect
        const ts = Date.now();
        const cid = this.clientId;
        const signable = `${authv}\n${appv}\n${ts}\n${this.streamId}\n${cid}\n`;
        const secret = this.clientSecret ?? getAppConfig().SRPC_AUTH_SECRET;
        if (!secret) throw new Error('SRPC_AUTH_SECRET is not configured.');

        const signature = createHmac('sha256', secret).update(signable).digest('hex');

        const params = new URLSearchParams({
            authv: String(authv),
            appv,
            ts: String(ts),
            id: this.streamId,
            cid,
            signature,
            _v: String(this.protocolVersion)
        });

        if (this.supersede) {
            params.set('_supersede', '1');
            this.supersede = false;
        }

        if (this.clientMeta) {
            for (const [key, value] of Object.entries(this.clientMeta)) {
                params.set(`m--${key}`, String(value));
            }
        }

        const baseUri = this.uri.startsWith('ws://') || this.uri.startsWith('wss://') ? this.uri : `ws://${this.uri}`;
        const url = new URL(baseUri);
        url.search = params.toString();

        return url.toString();
    }

    private decodeMessage(data: Buffer): (TServerOutput & BaseMessage) | null {
        try {
            return this.inboundType.decode(data) as TServerOutput & BaseMessage;
        } catch (err) {
            this.logger.error('Failed to decode message', { err: String(err) });
            return null;
        }
    }

    private writeMessage(message: BaseMessage): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            const encoded = this.outboundType.encode(message as TClientInput).finish();
            this.ws.send(encoded);
            return true;
        } catch (err) {
            this.logger.error('Failed to encode/send message', { err: String(err) });
            return false;
        }
    }

    ////////////////////////////////////////
    // Byte Stream Support

    byteStream = {
        parentStreamId: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        write: (streamId: number, chunk: any) => {
            return this.writeMessage({ byteStreamOperation: { streamId, write: { chunk } } });
        },
        finish: (streamId: number) => {
            this.writeMessage({ byteStreamOperation: { streamId, finish: {} } });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        destroy: (streamId: number, err?: any) => {
            this.writeMessage({ byteStreamOperation: { streamId, destroy: { error: err ? String(err) : undefined } } });
        },
        attachDisconnectHandler: (handler: () => void) => {
            this.ws?.on('close', handler);
        },
        detachDisconnectHandler: (handler: () => void) => {
            this.ws?.off('close', handler);
        },
        getBufferedAmount: () => {
            return this.ws?.bufferedAmount ?? 0;
        }
    };

    ////////////////////////////////////////
    // Public API

    registerConnectionHandler(handler: () => void) {
        this.streamConnectionHandlers.add(handler);
    }

    /**
     * Register a handler for server requests (downstream/server-initiated).
     * @example client.registerMessageHandler('dNotify', async (data) => ({ acknowledged: true }))
     */
    registerMessageHandler<P extends InvokePrefixes<TServerOutput, TClientInput>>(
        prefix: P,
        handler: (data: HandlerRequestData<TServerOutput, P>) => Promise<ResponseData<TClientInput, P>>
    ) {
        const actionType = `${prefix}Request` as RequestKeys<TServerOutput>;
        const resultType = `${prefix}Response`;
        this.streamMessageHandlers.set(actionType, {
            resultType,
            handler
        });
    }

    registerDisconnectHandler(handler: (cause: SrpcDisconnectCause) => void) {
        this.streamDisconnectionHandlers.add(handler);
    }

    /**
     * Invoke a server method.
     * @example client.invoke('uEcho', { message: 'hello' })
     */
    invoke<P extends InvokePrefixes<TClientInput, TServerOutput>>(
        prefix: P,
        data: RequestData<TClientInput, P>,
        timeoutMs = 30_000
    ): Promise<ResponseData<TServerOutput, P>> {
        const requestType = `${prefix}Request`;
        const resultType = `${prefix}Response`;
        const requestId = uuid7();

        const traceContext = getTraceContext();
        const trace = traceContext ? { traceId: traceContext.traceId, spanId: traceContext.spanId, traceFlags: traceContext.traceFlags } : undefined;

        return withSpan('srpc:invokeServer', { requestType }, () =>
            withLoggerContext({ srpc: { requestId, requestType, traceId: trace?.traceId } }, async () => {
                this.logger.info('Requesting server invocation');
                let timeoutHandle: NodeJS.Timeout | undefined;
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const responsePromise = new Promise<any>((resolve, reject) => {
                        this.requestQueue.set(requestId, {
                            exp: Date.now() + timeoutMs,
                            resolve,
                            reject
                        });
                        const sent = this.writeMessage({ requestId, trace, [requestType]: data });
                        if (!sent) {
                            this.requestQueue.delete(requestId);
                            reject(new Error('Failed to send request: not connected'));
                        }
                    });

                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutHandle = setTimeout(() => {
                            if (this.requestQueue.has(requestId)) {
                                this.requestQueue.delete(requestId);
                                reject(new Error(`Request timeout after ${timeoutMs}ms`));
                            }
                        }, timeoutMs);
                    });

                    const result = await Promise.race([responsePromise, timeoutPromise]);
                    clearTimeout(timeoutHandle);

                    // Use null check instead of `in` for consistency with ts-proto field materialization
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    if ((result as any)[resultType] == null) {
                        throw new Error('Invalid response from server');
                    }

                    this.logger.info('Server invocation completed');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (result as any)[resultType];
                } catch (err) {
                    clearTimeout(timeoutHandle);
                    this.logger.warn('Server invocation failed', err);
                    throw err;
                }
            })
        );
    }
}
