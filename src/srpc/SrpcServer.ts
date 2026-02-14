import { ApplicationServer } from '@deepkit/framework';
import { ScopedLogger } from '@deepkit/logger';
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
import { uuid } from '@deepkit/type';

const StreamInfoSymbol = Symbol('srpc-info');
const UpgradeClaimedSymbol = Symbol('srpc-upgrade-claimed');
const _patchedServers = new WeakSet<import('http').Server>();

/**
 * Monkey-patches `httpServer.emit` so that once an upgrade listener claims
 * a socket (by setting UpgradeClaimedSymbol), no further listeners are
 * invoked.  This prevents consumer @AutoStart services from destroying
 * sockets that an SrpcServer is already handling.
 *
 * Also installs a low-priority fallback that destroys any socket not
 * claimed by any handler (via setImmediate, after all sync work).
 */
export function installUpgradeClaimHandling(httpServer: import('http').Server) {
    if (_patchedServers.has(httpServer)) return;
    _patchedServers.add(httpServer);

    // Patch emit to stop propagation once a socket is claimed.
    const originalEmit = httpServer.emit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    httpServer.emit = function (this: import('http').Server, event: string | symbol, ...args: any[]): boolean {
        if (event !== 'upgrade') {
            return originalEmit.apply(this, [event, ...args]);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const socket = args[1] as any;
        const listeners = this.rawListeners('upgrade').slice();
        for (const fn of listeners) {
            (fn as Function).apply(this, args);
            if (socket[UpgradeClaimedSymbol]) break;
        }
        return listeners.length > 0;
    };

    // Fallback: destroy sockets not claimed by any handler.
    httpServer.on('upgrade', (_req, socket: import('net').Socket) => {
        setImmediate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!(socket as any)[UpgradeClaimedSymbol] && !socket.destroyed) {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();
            }
        });
    });
}

/**
 * Returns `true` if the given socket has already been claimed by an
 * upgrade handler (via `markUpgradeClaimed`).
 */
export function isUpgradeClaimed(socket: import('net').Socket): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !!(socket as any)[UpgradeClaimedSymbol];
}

/**
 * Mark a socket as claimed so that `installUpgradeClaimHandling`'s
 * patched emit stops propagating the `'upgrade'` event to subsequent
 * listeners.  SrpcServer calls this automatically; consumer apps with
 * their own WebSocket upgrade logic can call it to participate in the
 * same claim protocol.
 */
export function markUpgradeClaimed(socket: import('net').Socket): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (socket as any)[UpgradeClaimedSymbol] = true;
}

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private upgradeHandler: (...args: any[]) => void;
    private inboundType: SrpcMessageFns<TClientOutput>;
    private outboundType: SrpcMessageFns<TServerOutput>;

    private clientAuthorizer?: (metadata: SrpcMeta, req: IncomingMessage) => Promise<boolean | SrpcMeta>;
    private clientKeyFetcher?: (clientId: string) => Promise<false | string>;
    private streamConnectionHandlers = new Set<(stream: SrpcStream<TMeta>) => void>();
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

    constructor(private options: ISrpcServerOptions<TClientOutput, TServerOutput>) {
        const logLevel = options.logLevel ?? 'info';
        if (logLevel === false) {
            const noop = (() => {}) as any;
            this.logger = { info: noop, warn: noop, error: noop, debug: noop } as any;
            options.debug = false;
        } else if (logLevel === 'debug') {
            const base = options.logger;
            this.logger = {
                info: base.debug.bind(base),
                warn: base.warn.bind(base),
                error: base.error.bind(base),
                debug: base.debug.bind(base)
            } as any;
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
        const app = r(ApplicationServer);
        this.httpServer = app.getHttpWorker()['server']!;
        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', this.attachConnection.bind(this));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.upgradeHandler = (req: IncomingMessage, socket: any, head: Buffer) => {
            const pathname = req.url?.split('?')[0];
            if (pathname !== options.wsPath) return;

            markUpgradeClaimed(socket);

            this.verifyClient({ origin: '', secure: false, req }, (allowed, code, message) => {
                if (!allowed) {
                    socket.write(`HTTP/1.1 ${code ?? 403} ${message ?? 'Forbidden'}\r\n\r\n`);
                    socket.destroy();
                    return;
                }
                this.wsServer.handleUpgrade(req, socket, head, ws => {
                    this.wsServer.emit('connection', ws, req);
                });
            });
        };
        this.httpServer.prependListener('upgrade', this.upgradeHandler);
        installUpgradeClaimHandling(this.httpServer);

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
        const { clientId, clientStreamId, appVersion, address, configureTs, meta } = (req as any)[StreamInfoSymbol];

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
            connectedAt: now,
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

        ws.on('message', data => this.handleWsMessage(stream, data));
        ws.on('error', err => this.handleStreamError(stream, err));
        ws.on('close', () => this.handleStreamDisconnected(stream));

        this.handleStreamEstablished(stream);
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

    private closeStreamWithError(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause, message: string) {
        stream.$ws.close(cause === 'disconnect' ? 1000 : 4000, message.substring(0, 123));
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
        this.httpServer.off('upgrade', this.upgradeHandler);
        for (const stream of this.streamsById.values()) {
            this.cleanupStream(stream, 'disconnect');
        }
        this.wsServer.close();
    }

    ////////////////////////////////////////
    // Stream Lifecycle

    private handleStreamEstablished(stream: SrpcStream<TMeta>) {
        const conflictingStream = this.streamsByClientId.get(stream.clientId);
        if (conflictingStream) {
            this.logger.warn('Kicking existing stream with same client ID', {
                streamId: stream.id,
                clientId: stream.clientId,
                conflictingStreamId: conflictingStream.id
            });
            this.cleanupStream(conflictingStream, 'duplicate');
        }

        this.streamsById.set(stream.id, stream);
        this.streamsByClientId.set(stream.clientId, stream);
        this.streamConnectionHandlers.forEach(handler => handler(stream));

        this.writeToStream(stream, { pingPong: {} } as TServerOutput);
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

    private cleanupStream(stream: SrpcStream<TMeta>, forceCause?: SrpcDisconnectCause) {
        if (stream.lastPingAt < 0) return; // already cleaned up
        stream.lastPingAt = -1;

        if (forceCause) this.closeStreamWithError(stream, forceCause, `Stream terminated with cause: ${forceCause}`);
        this.streamDisconnectionHandlers.forEach(handler => handler(stream, forceCause ?? 'disconnect'));

        stream.$queue.forEach(item => item.reject(new Error('Stream disconnected')));
        stream.$queue.clear();

        this.streamsById.delete(stream.id);

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

        this.handleClientRequest(stream, requestId, data).then(
            response => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.writeToStream(stream, { requestId, reply: true, ...response } as any);
            },
            err => {
                this.logger.warn('Error processing client request', err, { srpc: { streamId, clientId, requestId } });
                const isUserError = err instanceof SrpcError && err.isUserError;
                this.writeToStream(stream, {
                    requestId,
                    reply: true,
                    error: isUserError ? err.message : String(err),
                    userError: isUserError
                } as TServerOutput);
            }
        );
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async runMessageHandler(handler: TSrpcMessageHandlerFnOrClass<SrpcStream<TMeta>, any, any>, stream: SrpcStream<TMeta>, data: any) {
        if (isSrpcMessageHandlerClass(handler)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const handlerInstance = new (handler as any)() as ISrpcMessageHandler<SrpcStream<TMeta>, any, any>;
            return handlerInstance.handle(stream, data);
        }

        return handler(stream, data);
    }

    ////////////////////////////////////////
    // Public API

    registerConnectionHandler(handler: (stream: SrpcStream<TMeta>) => void) {
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
