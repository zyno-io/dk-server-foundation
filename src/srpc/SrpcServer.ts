import { ApplicationServer } from '@deepkit/framework';
import { ScopedLogger } from '@deepkit/logger';
import { uuid } from '@deepkit/type';
import { createHmac, timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';

import { getAppConfig, r } from '../app/resolver';
import { uuid7 } from '../helpers';
import { withLoggerContext } from '../services';
import { getTraceContext, withRemoteSpan, withSpan } from '../telemetry';
import { SrpcByteStream } from './SrpcByteStream';
import {
    BaseMessage,
    HandlerRequestData,
    InvokePrefixes,
    IQueuedRequest,
    ISrpcMessageHandler,
    ISrpcServerOptions,
    isSrpcMessageHandlerClass,
    RequestData,
    RequestKeys,
    ResponseData,
    SrpcDisconnectCause,
    SrpcError,
    SrpcMessageFns,
    SrpcMeta,
    SrpcStream,
    TSrpcMessageHandlerFnOrClass
} from './types';
import { installWebSocketUpgradeHandler } from './WebSocketUpgradeHandler';

const StreamInfoSymbol = Symbol('srpc-info');

export class SrpcServer<
    TMeta extends SrpcMeta = SrpcMeta,
    TClientOutput extends BaseMessage = BaseMessage,
    TServerOutput extends BaseMessage = BaseMessage
> {
    private standardSrpcAuthKey?: string;
    private authClockDriftMs: number;
    private useRealIpHeader: boolean;

    private logger: ScopedLogger;
    private wsServer: WebSocket.Server;
    private httpServer: import('http').Server;
    private inboundType: SrpcMessageFns<TClientOutput>;
    private outboundType: SrpcMessageFns<TServerOutput>;

    private clientAuthorizer?: (metadata: SrpcMeta, req: IncomingMessage) => Promise<boolean | SrpcMeta>;
    private clientKeyFetcher?: (clientId: string) => Promise<false | string>;
    private streamConnectionHandlers = new Set<(stream: SrpcStream<TMeta>) => void | Promise<void>>();
    private blockedClientRequests = new WeakSet<SrpcStream<TMeta>>();
    private pendingClientRequests = new WeakMap<SrpcStream<TMeta>, TClientOutput[]>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private streamMessageHandlers = new Map<
        RequestKeys<TClientOutput>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { resultType: string; handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, any, any> }
    >();
    private streamDisconnectionHandlers = new Set<(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause) => void>();
    private inactivityCheckInterval: ReturnType<typeof setInterval>;

    public readonly streamsById = new Map<string, SrpcStream<TMeta>>();
    public readonly streamsByClientId = new Map<string, SrpcStream<TMeta>>();
    protected readonly pendingStreamsByClientId = new Map<string, SrpcStream<TMeta>>();

    constructor(private options: ISrpcServerOptions<TClientOutput, TServerOutput>) {
        const logLevel = options.logLevel ?? 'info';
        if (logLevel === false) {
            const noop = (() => {}) as (...args: unknown[]) => void;
            this.logger = { info: noop, warn: noop, error: noop, debug: noop } as unknown as ScopedLogger;
            options.debug = false;
        } else if (logLevel === 'debug') {
            const base = options.logger;
            this.logger = {
                info: base.debug.bind(base),
                warn: base.warn.bind(base),
                error: base.error.bind(base),
                debug: base.debug.bind(base)
            } as unknown as ScopedLogger;
        } else {
            this.logger = options.logger;
        }
        this.inboundType = options.clientMessage;
        this.outboundType = options.serverMessage;

        const appConfig = getAppConfig();
        this.standardSrpcAuthKey = appConfig.SRPC_AUTH_SECRET;
        this.authClockDriftMs = appConfig.SRPC_AUTH_CLOCK_DRIFT_MS;
        this.useRealIpHeader = appConfig.USE_REAL_IP_HEADER ?? false;

        // WebSocket server setup — use noServer mode so multiple ws servers
        // can coexist on the same HTTP server without aborting each other's
        // upgrade requests (the default `{ server, path }` mode aborts
        // non-matching upgrades, breaking other ws servers on the same port).
        if (options.httpServer) {
            this.httpServer = options.httpServer as import('http').Server;
        } else {
            const app = r(ApplicationServer);
            this.httpServer = app.getHttpWorker()['server']!;
        }
        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', this.attachConnection.bind(this));

        installWebSocketUpgradeHandler({
            httpServer: this.httpServer,
            wsPath: options.wsPath,
            wsServer: this.wsServer,
            verifyClient: this.verifyClient.bind(this)
        });

        this.logger.info('WebSocket server listening', { path: options.wsPath });

        this.inactivityCheckInterval = setInterval(() => this.terminateInactiveStreams(), 15_000);
    }

    ////////////////////////////////////////
    // WebSocket Connection Handling

    private verifyClient(
        info: { origin: string; secure: boolean; req: IncomingMessage },
        cb: (res: boolean, code?: number, message?: string) => void
    ) {
        const url = new URL(info.req.url!, 'http://localhost');
        const q = Object.fromEntries(url.searchParams.entries());

        const { id: clientStreamId, cid: clientId, appv: appVersion } = q;
        const address = (this.useRealIpHeader && info.req.headers['x-real-ip']) || info.req.socket.remoteAddress;

        this.logger.info('Incoming streaming WebSocket request', {
            address,
            clientStreamId,
            clientId,
            appVersion
        });

        if (!clientStreamId || !clientId || !appVersion) {
            this.logger.warn('Client missing required query parameters', { clientId, clientStreamId });
            cb(false, 400, 'Missing required query parameters');
            return;
        }

        this.validateClientAuth(q, info.req).then(
            result => {
                if (!result) {
                    this.logger.warn('Client failed authentication', { clientId, clientStreamId });
                    // eslint-disable-next-line promise/no-callback-in-promise
                    return cb(false, 403, 'Failed authentication');
                }

                const authMeta = result !== true ? result : undefined;
                const meta = Object.fromEntries(
                    Object.entries(q)
                        .filter(([key]) => key.startsWith('m--'))
                        .map(([key, value]) => [key.slice(3), value])
                );

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (info.req as any)[StreamInfoSymbol] = {
                    clientStreamId,
                    clientId,
                    appVersion,
                    configureTs: parseInt(q.ts ?? '0'),
                    protocolVersion: parseInt(q._v ?? '1'),
                    supersede: q._supersede === '1',
                    address,
                    meta: {
                        ...meta,
                        ...authMeta
                    }
                };

                // eslint-disable-next-line promise/no-callback-in-promise
                cb(true);
            },
            err => {
                this.logger.error('Error validating client auth', err, { clientId, clientStreamId });
                // eslint-disable-next-line promise/no-callback-in-promise
                cb(false, 500, 'Error during authentication');
            }
        );
    }

    private attachConnection(ws: WebSocket, req: IncomingMessage) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { clientId, clientStreamId, appVersion, address, configureTs, protocolVersion, supersede, meta } = (req as any)[StreamInfoSymbol];

        const streamId = uuid();

        this.logger.info('WebSocket request answered', {
            address,
            streamId,
            clientId,
            clientStreamId,
            meta
        });

        const now = Date.now();
        const stream: SrpcStream<TMeta> = {
            $ws: ws,
            $queue: new Map<string, IQueuedRequest>(),
            id: streamId,
            clientStreamId,
            address,
            clientId,
            appVersion,
            configureTs,
            protocolVersion,
            supersede,
            connectedAt: now,
            isActivated: false,
            lastPingAt: now,
            meta,
            byteStream: {
                parentStreamId: streamId,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                write: (substreamId: number, chunk: any) => {
                    this.write(ws, { byteStreamOperation: { streamId: substreamId, write: { chunk } } } as TServerOutput);
                    return true;
                },
                finish: (substreamId: number) => {
                    this.write(ws, { byteStreamOperation: { streamId: substreamId, finish: {} } } as TServerOutput);
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                destroy: (substreamId: number, err?: any) => {
                    this.write(ws, {
                        byteStreamOperation: { streamId: substreamId, destroy: { error: err ? String(err) : undefined } }
                    } as TServerOutput);
                },
                attachDisconnectHandler(handler: () => void) {
                    ws.on('close', handler);
                },
                detachDisconnectHandler(handler: () => void) {
                    ws.off('close', handler);
                },
                getBufferedAmount() {
                    return ws.bufferedAmount;
                }
            }
        };

        SrpcByteStream.init(stream, { startId: 2, step: 2 });

        ws.on('error', err => this.handleStreamError(stream, err));
        ws.on('close', () => this.handleStreamDisconnected(stream));

        this.handleStreamEstablished(stream, supersede);
    }

    private handleWsMessage(stream: SrpcStream<TMeta>, data: WebSocket.Data) {
        if (!(data instanceof Buffer)) {
            return this.closeStreamWithError(stream, 'badArg', 'Received non-binary data');
        }

        try {
            const decoded = this.inboundType.decode(data as Uint8Array);
            this.handleStreamDataReceived(stream, decoded);
        } catch (error) {
            this.logger.warn('Failed to decode message', { error, streamId: stream.id, clientId: stream.clientId });
            return this.closeStreamWithError(stream, 'badArg', 'Invalid message format');
        }
    }

    private write(ws: WebSocket, message: TServerOutput) {
        const encoded = this.outboundType.encode(message).finish();
        ws.send(encoded);
    }

    private writeToStream(stream: SrpcStream<TMeta>, data: TServerOutput): void {
        this.write(stream.$ws, data);
    }

    protected getCurrentStreamByClientId(clientId: string): SrpcStream<TMeta> | undefined {
        return this.pendingStreamsByClientId.get(clientId) ?? this.streamsByClientId.get(clientId);
    }

    protected isCurrentStream(stream: SrpcStream<TMeta>): boolean {
        return this.getCurrentStreamByClientId(stream.clientId) === stream;
    }

    private activateStream(stream: SrpcStream<TMeta>): void {
        if (stream.lastPingAt < 0 || !this.isCurrentStream(stream)) {
            return;
        }
        this.pendingStreamsByClientId.delete(stream.clientId);
        stream.isActivated = true;
        this.streamsByClientId.set(stream.clientId, stream);
    }

    // IMPORTANT: SrpcClient.parseDisconnectCause() matches on the close code number
    // to determine the disconnect cause. If you change these codes, update the client too.
    private static readonly CLOSE_CODES: Record<SrpcDisconnectCause, number> = {
        disconnect: 1000,
        badArg: 4000,
        conflict: 4001,
        supersede: 4002,
        timeout: 4003
    };

    private closeStreamWithError(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause, message: string) {
        stream.$ws.close(SrpcServer.CLOSE_CODES[cause], message.substring(0, 123));
    }

    ////////////////////////////////////////
    // Authentication

    private async validateClientAuth(meta: SrpcMeta, req: IncomingMessage) {
        if (this.clientAuthorizer) {
            return this.clientAuthorizer(meta, req);
        }

        const { authv, appv, ts, id, cid, signature } = meta;
        if (!meta.authv || !meta.appv || !meta.ts || !meta.signature) {
            throw new Error('Missing authorization metadata');
        }

        const clientKey = await this.fetchClientKey(cid);
        if (clientKey === false) return false;

        const tsInt = parseInt(ts, 10);
        if (isNaN(tsInt)) {
            this.logger.warn('Invalid timestamp');
            return false;
        }

        if (Math.abs(Date.now() - tsInt) > this.authClockDriftMs) {
            this.logger.warn('Timestamp expired');
            return false;
        }

        const computedSignature = createHmac('sha256', clientKey).update(`${authv}\n${appv}\n${ts}\n${id}\n${cid}\n`).digest('hex');

        const sigBuf = Buffer.from(signature ?? '');
        const computedBuf = Buffer.from(computedSignature);
        if (sigBuf.length !== computedBuf.length || !timingSafeEqual(sigBuf, computedBuf)) {
            this.logger.warn('Invalid signature');
            return false;
        }

        return true;
    }

    private async fetchClientKey(clientId: string) {
        if (this.clientKeyFetcher) return this.clientKeyFetcher(clientId);
        if (!this.standardSrpcAuthKey) {
            throw new Error('SRPC_AUTH_SECRET is not configured.');
        }
        return this.standardSrpcAuthKey;
    }

    setClientAuthorizer(authorizer: (metadata: SrpcMeta, req: IncomingMessage) => Promise<boolean | SrpcMeta>) {
        this.clientAuthorizer = authorizer;
    }

    setClientKeyFetcher(fetcher: (clientId: string) => Promise<false | string>) {
        this.clientKeyFetcher = fetcher;
    }

    close() {
        clearInterval(this.inactivityCheckInterval);
        for (const stream of this.streamsById.values()) {
            this.cleanupStream(stream, 'disconnect');
        }
        this.wsServer.close();
    }

    ////////////////////////////////////////
    // Stream Lifecycle

    private handleStreamEstablished(stream: SrpcStream<TMeta>, supersede: boolean) {
        const conflictingStream = this.getCurrentStreamByClientId(stream.clientId);
        if (conflictingStream) {
            if (stream.protocolVersion >= 2 && !supersede) {
                this.logger.warn('Rejecting new connection due to existing client ID', {
                    streamId: stream.id,
                    clientId: stream.clientId,
                    existingStreamId: conflictingStream.id
                });
                stream.lastPingAt = -1; // mark as cleaned up so cleanupStream no-ops on ws close
                this.closeStreamWithError(stream, 'conflict', 'Client ID already connected');
                return;
            }

            this.logger.warn('Kicking existing stream with same client ID', {
                streamId: stream.id,
                clientId: stream.clientId,
                conflictingStreamId: conflictingStream.id
            });
            this.cleanupStream(conflictingStream, 'supersede');
        }

        // Register in local maps before the async hook so lifecycle chains
        // can observe the replacement stream without exposing it for
        // clientId-based delivery until activation succeeds.
        this.streamsById.set(stream.id, stream);
        this.pendingStreamsByClientId.set(stream.clientId, stream);
        this.blockedClientRequests.add(stream);

        // Async hook for subclass checks (e.g. cross-pod mesh registration).
        // Activation is deferred until the hook resolves, so no handlers run
        // and no RPCs are processed until the subclass confirms the stream
        // should proceed.
        this.postEstablishCheck(stream)
            .then(async rejected => {
                if (rejected) return; // subclass already called cleanupStream
                // Stream may have been cleaned up during the async gap
                if (stream.lastPingAt < 0) return;
                // Preserve pingPong as the first server frame. Client traffic sent
                // before activation completes is queued until activation succeeds,
                // unless it is a reply to a server-initiated request.
                this.writeToStream(stream, { pingPong: {} } as TServerOutput);
                stream.$ws.on('message', data => this.handleWsMessage(stream, data));
                try {
                    await this.onStreamConnected(stream);
                } catch (err) {
                    this.logger.error('onStreamConnected failed, disconnecting stream', err, {
                        streamId: stream.id,
                        clientId: stream.clientId
                    });
                    this.cleanupStream(stream, 'disconnect');
                    return;
                }
                if (stream.lastPingAt < 0) return;
                this.activateStream(stream);
                if (!stream.isActivated) return;
                try {
                    await this.onStreamActivated(stream);
                } catch (err) {
                    this.logger.error('onStreamActivated failed, disconnecting stream', err, {
                        streamId: stream.id,
                        clientId: stream.clientId
                    });
                    this.cleanupStream(stream, 'disconnect');
                    return;
                }
                if (stream.lastPingAt < 0 || !stream.isActivated) return;
                this.openClientRequests(stream);
            })
            .catch(err => {
                this.logger.error('postEstablishCheck failed, disconnecting stream', err, {
                    streamId: stream.id,
                    clientId: stream.clientId
                });
                this.cleanupStream(stream, 'disconnect');
            });
    }

    /**
     * Async hook called after a stream is registered in local maps but before
     * the initial handshake ping is sent. Return true to reject the stream;
     * the subclass must call cleanupStream() before returning true. The base
     * implementation accepts all streams immediately.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected postEstablishCheck(_stream: SrpcStream<TMeta>): Promise<boolean> {
        return Promise.resolve(false);
    }

    private handleStreamDisconnected(stream: SrpcStream<TMeta>): void {
        const { id: streamId, clientId } = stream;
        this.logger.info('Stream disconnected', { streamId, clientId });
        this.cleanupStream(stream);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handleStreamError(stream: SrpcStream<TMeta>, err: any): void {
        const { id: streamId, clientId } = stream;
        this.logger.warn('Stream error', { err, streamId, clientId });
        this.cleanupStream(stream);
    }

    private terminateInactiveStreams() {
        const deadlineMs = Date.now() - 75_000;
        for (const stream of this.streamsById.values()) {
            if (stream.lastPingAt < deadlineMs) {
                this.logger.warn('Terminating inactive stream', { streamId: stream.id, clientId: stream.clientId });
                this.cleanupStream(stream, 'timeout');
            }
        }
    }

    protected cleanupStream(stream: SrpcStream<TMeta>, forceCause?: SrpcDisconnectCause) {
        if (stream.lastPingAt < 0) return; // already cleaned up
        stream.lastPingAt = -1;

        if (forceCause) this.closeStreamWithError(stream, forceCause, `Stream terminated with cause: ${forceCause}`);
        this.onStreamDisconnected(stream, forceCause ?? 'disconnect');

        stream.$queue.forEach(item => item.reject(new Error('Stream disconnected')));
        stream.$queue.clear();
        this.blockedClientRequests.delete(stream);
        this.pendingClientRequests.delete(stream);

        this.streamsById.delete(stream.id);
        if (this.pendingStreamsByClientId.get(stream.clientId) === stream) {
            this.pendingStreamsByClientId.delete(stream.clientId);
        }

        if (this.streamsByClientId.get(stream.clientId) === stream) {
            this.streamsByClientId.delete(stream.clientId);
        }
    }

    ////////////////////////////////////////
    // Message Handling

    private handleStreamDataReceived(stream: SrpcStream<TMeta>, data: TClientOutput): void {
        if (data.pingPong) {
            stream.lastPingAt = Date.now();
            return this.writeToStream(stream, { pingPong: {} } as TServerOutput);
        }

        if (data.byteStreamOperation) {
            return this.handleByteSubstreamOperation(stream, data.byteStreamOperation);
        }

        const { id: streamId, clientId } = stream;
        const { requestId, reply } = data;

        if ((!stream.isActivated || this.blockedClientRequests.has(stream)) && !reply) {
            const queued = this.pendingClientRequests.get(stream) ?? [];
            queued.push(data);
            this.pendingClientRequests.set(stream, queued);
            this.logger.debug('Queueing client request before stream activation', { streamId, clientId, requestId });
            return;
        }

        const logObject = {
            streamId,
            clientId,
            requestId,
            reply,
            error: data.userError ? 'user' : data.error ? 'application' : undefined
        };
        this.logger[this.options.debug ? 'info' : 'debug']('Client message received', this.options.debug ? { ...logObject, data } : logObject);

        if (!requestId) {
            this.logger.warn('Invalid request ID', { srpc: { streamId, clientId, requestId } });
            return this.closeStreamWithError(stream, 'badArg', 'Invalid request ID');
        }

        if (reply) {
            const queueItem = stream.$queue.get(requestId);
            if (!queueItem) {
                this.logger.warn('Unknown request ID for reply', { srpc: { streamId, clientId, requestId } });
                return this.closeStreamWithError(stream, 'badArg', 'Unknown request ID');
            }

            stream.$queue.delete(requestId);
            if (data.error) {
                return queueItem.reject(new SrpcError(data.error, data.userError));
            }
            return queueItem.resolve(data);
        }

        this.handleClientRequest(stream, requestId, data)
            .then(response => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.writeToStream(stream, { requestId, reply: true, ...response } as any);
            })
            .catch(err => {
                this.logger.warn('Error processing client request', err, { srpc: { streamId, clientId, requestId } });
                const isUserError = err instanceof SrpcError && err.isUserError;
                this.writeToStream(stream, {
                    requestId,
                    reply: true,
                    error: isUserError ? err.message : String(err),
                    userError: isUserError
                } as TServerOutput);
            });
    }

    private handleByteSubstreamOperation(stream: SrpcStream<TMeta>, op: NonNullable<TClientOutput['byteStreamOperation']>): void {
        if (op.write) {
            return SrpcByteStream.writeReceiver(stream, op.streamId, op.write.chunk);
        }

        if (op.finish) {
            return SrpcByteStream.finishReceiver(stream, op.streamId);
        }

        if (op.destroy) {
            return SrpcByteStream.destroySubstream(stream, op.streamId, op.destroy.error);
        }
    }

    private async handleClientRequest(stream: SrpcStream<TMeta>, requestId: string, message: TClientOutput): Promise<Partial<TServerOutput>> {
        const logMeta = { streamId: stream.id, clientId: stream.clientId, requestId };

        for (const key of this.streamMessageHandlers.keys()) {
            if (message[key]) {
                Object.assign(logMeta, { requestType: key });
                return withRemoteSpan('srpc:handleClientRequest', message.trace, logMeta, () =>
                    withLoggerContext({ srpc: logMeta }, async () => {
                        try {
                            this.logger.info('Client request received');
                            const handlerMeta = this.streamMessageHandlers.get(key)!;
                            const result = await this.runMessageHandler(handlerMeta.handler, stream, message[key]);
                            this.logger.info('Client request processed');
                            return {
                                [handlerMeta.resultType]: result
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            } as any;
                        } catch (err) {
                            this.logger.warn('Client request failed', err);
                            throw err;
                        }
                    })
                );
            }
        }

        throw new Error('Unhandled message type');
    }

    private openClientRequests(stream: SrpcStream<TMeta>): void {
        this.blockedClientRequests.delete(stream);
        const queued = this.pendingClientRequests.get(stream);
        if (!queued?.length) return;

        this.pendingClientRequests.delete(stream);
        for (const request of queued) {
            this.handleStreamDataReceived(stream, request);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async runMessageHandler(handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, any, any>, stream: SrpcStream<TMeta>, data: any) {
        if (isSrpcMessageHandlerClass(handler)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const handlerInstance = new (handler as any)() as ISrpcMessageHandler<SrpcStream<TMeta>, any, any>;
            return handlerInstance.handle(stream, data);
        }

        return handler(stream, data);
    }

    protected async onStreamConnected(stream: SrpcStream<TMeta>): Promise<void> {
        for (const handler of this.streamConnectionHandlers) {
            await handler(stream);
        }
    }

    protected onStreamActivated(_stream: SrpcStream<TMeta>): void | Promise<void> {}

    protected onStreamDisconnected(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause): void {
        this.streamDisconnectionHandlers.forEach(handler => handler(stream, cause));
    }

    ////////////////////////////////////////
    // Public API

    /**
     * Register a handler that runs after the initial handshake ping is sent.
     * Throwing or rejecting aborts activation and disconnects the stream.
     */
    registerConnectionHandler(handler: (stream: SrpcStream<TMeta>) => void | Promise<void>) {
        this.streamConnectionHandlers.add(handler);
    }

    /**
     * Register a handler for client requests.
     * @example server.registerMessageHandler('uEcho', async (stream, data) => ({ message: `Echo: ${data.message}` }))
     */
    registerMessageHandler<P extends InvokePrefixes<TClientOutput, TServerOutput>>(
        prefix: P,
        handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, HandlerRequestData<TClientOutput, P>, ResponseData<TServerOutput, P>>
    ) {
        const actionType = `${prefix}Request` as RequestKeys<TClientOutput>;
        const resultType = `${prefix}Response`;
        this.streamMessageHandlers.set(actionType, {
            resultType,
            handler
        });
    }

    registerDisconnectHandler(handler: (stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause) => void) {
        this.streamDisconnectionHandlers.add(handler);
    }

    /**
     * Invoke a client method.
     * @example server.invoke(stream, 'dNotify', { notification: 'hello' })
     */
    invoke<P extends InvokePrefixes<TServerOutput, TClientOutput>>(
        stream: SrpcStream<TMeta>,
        prefix: P,
        data: RequestData<TServerOutput, P>,
        timeoutMs = 30_000
    ): Promise<ResponseData<TClientOutput, P>> {
        const requestType = `${prefix}Request`;
        const resultType = `${prefix}Response`;
        const requestId = uuid7();

        const traceContext = getTraceContext();
        const trace = traceContext ? { traceId: traceContext.traceId, spanId: traceContext.spanId, traceFlags: traceContext.traceFlags } : undefined;

        const logMeta = { streamId: stream.id, clientId: stream.clientId, requestId, requestType };
        return withSpan('srpc:invokeClient', logMeta, () =>
            withLoggerContext({ srpc: logMeta }, async () => {
                try {
                    this.logger.info('Requesting client invocation', this.options.debug ? { data } : undefined);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const response = await new Promise<any>((resolve, reject) => {
                        stream.$queue.set(requestId, {
                            exp: Date.now() + timeoutMs,
                            resolve,
                            reject
                        });
                        this.writeToStream(stream, { requestId, trace, [requestType]: data } as unknown as TServerOutput);
                    });

                    // Use null check instead of `in` for consistency with ts-proto field materialization
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    if ((response as any)[resultType] == null) {
                        throw new Error('Invalid response from client');
                    }

                    this.logger.info('Client invocation completed');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (response as any)[resultType];
                } catch (err) {
                    const isUserError = err instanceof SrpcError && err.isUserError;
                    if (isUserError) {
                        this.logger.warn('Client invocation returned user error', { err: err.message });
                    } else {
                        this.logger.warn('Client invocation failed', err);
                    }
                    throw err;
                }
            })
        );
    }

    static createInvoke<TM extends SrpcMeta, TCO extends BaseMessage, TSO extends BaseMessage>(
        instanceFn: () => SrpcServer<TM, TCO, TSO>
    ): SrpcServer<TM, TCO, TSO>['invoke'] {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = (...args: any[]) => {
            const instance = instanceFn();
            // eslint-disable-next-line prefer-spread, @typescript-eslint/no-explicit-any
            return instance.invoke.apply(instance, args as any);
        };
        return fn as SrpcServer<TM, TCO, TSO>['invoke'];
    }
}
