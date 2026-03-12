/* eslint-disable @typescript-eslint/no-explicit-any */
import type { App } from '@deepkit/app';
import type { HttpRequest, HttpResponse } from '@deepkit/http';

import { uuid7 } from '../helpers/utils/uuid';
import { createLogger } from '../services';
import { DevConsoleController } from './devconsole.controller';
import { DevConsoleLocalhostMiddleware } from './devconsole.middleware';
import { createDevConsoleSrpcObserver, identifyMessageType } from './devconsole.srpc';
import { DevConsoleStore, type DevConsoleDatabaseQueryEntry, type DevConsoleErrorInfo, type DevConsoleMutexEntry } from './devconsole.store';

const _skipObserverSet = new WeakSet<object>();

export function skipDevConsoleObserver(server: object) {
    _skipObserverSet.add(server);
}

let _patchesApplied = false;

export function initDevConsole(app: App<any>) {
    const store = DevConsoleStore.init();

    app.appModule.addProvider(DevConsoleLocalhostMiddleware);
    app.appModule.addController(DevConsoleController);

    if (!_patchesApplied) {
        _patchesApplied = true;
        patchHttpKernel(store);
        patchHttpWorkflow();
        patchWorkerRecorder(store);
        patchSrpcClient(store);
        patchSrpcServer(store);
        patchMutex(store);
        patchDatabase(store);
    }
}

export function startDevConsoleSrpcServer() {
    const store = DevConsoleStore.get();
    if (!store) return;

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DevConsoleSrpcServer } = require('./devconsole.ws');
        const srpcServer = new DevConsoleSrpcServer(createLogger('DevConsole'));
        store.onEvent = (type, data) => srpcServer.broadcast(type, data);
    } catch (err) {
        console.warn('[DevConsole] Failed to start SRPC server', err);
    }
}

////////////////////////////////////////
// HTTP Kernel

function patchHttpKernel(store: DevConsoleStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CustomHttpKernel } = require('../http/kernel');
    const BODY_LIMIT = 32 * 1024;

    const origSkip = CustomHttpKernel.prototype.shouldSkipRequestLogging;
    CustomHttpKernel.prototype.shouldSkipRequestLogging = function (request: HttpRequest) {
        return origSkip.call(this, request) || request.url?.startsWith('/_devconsole');
    };

    const origHandleRequest = CustomHttpKernel.prototype.handleRequest;
    CustomHttpKernel.prototype.handleRequest = async function (req: HttpRequest, res: HttpResponse) {
        if (req.url?.startsWith('/_devconsole')) {
            return origHandleRequest.call(this, req, res);
        }

        const responseChunks: Buffer[] = [];
        let responseTotalBytes = 0;
        // Capture all response headers at the writeHead() funnel point.
        // Headers set via setHeader() are in the internal map; headers passed
        // directly to writeHead() are not.  Merge both here.
        const capturedHeaders: Record<string, string> = {};

        const origWriteHead = res.writeHead.bind(res);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.writeHead = function (statusCode: number, ...args: any[]) {
            // Grab setHeader() headers first, then overlay writeHead() argument headers
            for (const [key, val] of Object.entries(res.getHeaders())) {
                if (val != null) capturedHeaders[key] = String(val);
            }
            // writeHead(status, headers) or writeHead(status, statusMessage, headers)
            const headers = typeof args[0] === 'object' ? args[0] : args[1];
            if (headers) {
                for (const key of Object.keys(headers)) {
                    capturedHeaders[key.toLowerCase()] = headers[key];
                }
            }
            return origWriteHead(statusCode, ...args);
        } as typeof res.writeHead;

        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);

        res.write = function (chunk: any, ...args: any[]) {
            if (chunk) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                responseTotalBytes += buf.length;
                if (responseTotalBytes <= BODY_LIMIT) {
                    responseChunks.push(buf);
                }
            }
            return origWrite(chunk, ...args);
        } as typeof res.write;

        res.end = function (chunk: any, ...args: any[]) {
            if (chunk) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                responseTotalBytes += buf.length;
                if (responseTotalBytes <= BODY_LIMIT) {
                    responseChunks.push(buf);
                }
            }
            return origEnd(chunk, ...args);
        } as typeof res.end;

        try {
            await origHandleRequest.call(this, req, res);
        } finally {
            const contentType = capturedHeaders['content-type'] ?? '';
            const isText = contentType.includes('json') || contentType.includes('text') || contentType.includes('xml');
            let responseBody: string | null = null;
            if (responseChunks.length) {
                if (isText) {
                    responseBody = Buffer.concat(responseChunks).toString('utf8');
                    if (responseBody.length > BODY_LIMIT) {
                        responseBody = responseBody.slice(0, BODY_LIMIT) + '...(truncated)';
                    }
                } else {
                    responseBody = `<binary ${responseTotalBytes} bytes>`;
                }
            }

            let requestBody: string | null = null;
            const reqContentType = String(req.headers['content-type'] ?? '');
            const reqIsText =
                reqContentType.includes('json') ||
                reqContentType.includes('text') ||
                reqContentType.includes('xml') ||
                reqContentType.includes('form');
            if (req.body) {
                if (reqIsText) {
                    requestBody = req.body.toString('utf8').slice(0, BODY_LIMIT);
                } else {
                    requestBody = `<binary ${req.body.length} bytes>`;
                }
            }

            const controllerError = req.store['$ControllerError'];
            const errorInfo = controllerError ? serializeError(controllerError) : undefined;

            store.addHttpEntry({
                id: uuid7(),
                timestamp: req.store['$RequestTime'] ?? Date.now(),
                method: req.method ?? 'UNKNOWN',
                url: req.url ?? '',
                remoteAddress: req.socket?.remoteAddress ?? '',
                requestHeaders: req.headers as Record<string, string | string[] | undefined>,
                requestBody,
                statusCode: res.statusCode,
                responseHeaders: capturedHeaders as Record<string, string | string[] | undefined>,
                responseBody,
                durationMs: Date.now() - (req.store['$RequestTime'] ?? Date.now()),
                error: errorInfo
            });
        }
    };
}

////////////////////////////////////////
// HTTP Workflow (error capture for request inspector)

function patchHttpWorkflow() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HttpWorkflowListener } = require('../http/workflow');

    const origOnParametersFailed = HttpWorkflowListener.prototype.onParametersFailed;
    HttpWorkflowListener.prototype.onParametersFailed = function (event: any) {
        event.request.store['$ControllerError'] = event.error;
        return origOnParametersFailed.call(this, event);
    };

    const origOnControllerError = HttpWorkflowListener.prototype.onControllerError;
    HttpWorkflowListener.prototype.onControllerError = function (event: any) {
        event.request.store['$ControllerError'] = event.error;
        return origOnControllerError.call(this, event);
    };
}

////////////////////////////////////////
// Worker Recorder

function patchWorkerRecorder(store: DevConsoleStore) {
    let WorkerRecorderService: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        WorkerRecorderService = require('../services/worker/recorder').WorkerRecorderService;
    } catch {
        return;
    }

    const origStart = WorkerRecorderService.prototype.start;
    WorkerRecorderService.prototype.start = async function (this: any) {
        await origStart.call(this);

        const observer = this.observer;
        const queueName = this.queueName;
        if (observer) {
            observer.on('added', (args: any) => {
                store.onEvent?.('worker:added', { queue: queueName, queueId: args.jobId, name: args.name, status: 'waiting' });
            });
            observer.on('active', (args: any) => {
                store.onEvent?.('worker:active', { queue: queueName, queueId: args.jobId, status: 'active' });
            });
            observer.on('delayed', (args: any) => {
                store.onEvent?.('worker:delayed', { queue: queueName, queueId: args.jobId, status: 'delayed' });
            });
        }
    };

    const origLogJob = WorkerRecorderService.prototype.logJob;
    WorkerRecorderService.prototype.logJob = async function (this: any, job: any, status: 'completed' | 'failed', result: any) {
        await origLogJob.call(this, job, status, result);

        const traceparent = job.opts?.traceparent;
        const traceId = traceparent ? traceparent.split('-')[1] : null;
        store.onEvent?.('worker:job', {
            id: `${this.queueName}:${job.id}`,
            queue: this.queueName,
            queueId: job.id,
            name: job.name,
            data: job.data,
            status,
            result,
            attempt: job.attemptsMade,
            traceId,
            createdAt: job.timestamp,
            shouldExecuteAt: job.timestamp + (job.opts?.delay ?? 0),
            executedAt: job.processedOn ?? null,
            completedAt: job.finishedOn ?? null
        });
    };
}

////////////////////////////////////////
// SRPC Client

function patchSrpcClient(store: DevConsoleStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SrpcClient } = require('../srpc/SrpcClient');
    const observer = createDevConsoleSrpcObserver(store);
    const connectedAtMap = new WeakMap<object, number>();

    function buildObserverStream(client: any): any {
        return {
            id: client.streamId,
            clientId: client.clientId,
            clientStreamId: client.streamId,
            appVersion: '0.0.0',
            address: client.uri,
            configureTs: 0,
            connectedAt: connectedAtMap.get(client) ?? Date.now(),
            lastPingAt: client.lastPongMs ?? Date.now(),
            meta: client.clientMeta ?? {}
        };
    }

    const origHandshake = SrpcClient.prototype.handleInitialHandshake;
    SrpcClient.prototype.handleInitialHandshake = function (this: any, ws: any, data: any, clearConnectTimeout: any) {
        origHandshake.call(this, ws, data, clearConnectTimeout);
        if (this.isConnected) {
            connectedAtMap.set(this, Date.now());
            observer.onConnectionEstablished?.(buildObserverStream(this));
        }
    };

    const origDisconnect = SrpcClient.prototype.handleDisconnect;
    SrpcClient.prototype.handleDisconnect = function (this: any) {
        const wasConnected = this.isConnected;
        const stream = wasConnected ? buildObserverStream(this) : null;
        origDisconnect.call(this);
        if (stream) {
            observer.onConnectionClosed?.(stream, 'disconnect');
        }
    };

    const origHandleMessage = SrpcClient.prototype.handleMessage;
    SrpcClient.prototype.handleMessage = async function (this: any, data: Buffer) {
        const message = this.decodeMessage(data);
        if (message && !message.pingPong && !message.byteStreamOperation) {
            const msgType = identifyMessageType(message as Record<string, unknown>);
            observer.onInboundMessage?.(buildObserverStream(this), msgType, message as Record<string, unknown>);
        }
        await origHandleMessage.call(this, data);
    };

    const origWriteMessage = SrpcClient.prototype.writeMessage;
    SrpcClient.prototype.writeMessage = function (this: any, message: any) {
        if (!message.pingPong && !message.byteStreamOperation) {
            const msgType = identifyMessageType(message as Record<string, unknown>);
            observer.onOutboundMessage?.(buildObserverStream(this), msgType, message as Record<string, unknown>);
        }
        return origWriteMessage.call(this, message);
    };
}

////////////////////////////////////////
// SRPC Server

function patchSrpcServer(store: DevConsoleStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SrpcServer } = require('../srpc/SrpcServer');
    const observer = createDevConsoleSrpcObserver(store);

    const origEstablished = SrpcServer.prototype.handleStreamEstablished;
    SrpcServer.prototype.handleStreamEstablished = function (this: any, stream: any) {
        origEstablished.call(this, stream);
        if (!_skipObserverSet.has(this)) {
            observer.onConnectionEstablished?.(stream);
        }
    };

    const origCleanup = SrpcServer.prototype.cleanupStream;
    SrpcServer.prototype.cleanupStream = function (this: any, stream: any, forceCause?: string) {
        const shouldObserve = !_skipObserverSet.has(this) && stream.lastPingAt >= 0;
        origCleanup.call(this, stream, forceCause);
        if (shouldObserve) {
            observer.onConnectionClosed?.(stream, forceCause ?? 'disconnect');
        }
    };

    const origDataReceived = SrpcServer.prototype.handleStreamDataReceived;
    SrpcServer.prototype.handleStreamDataReceived = function (this: any, stream: any, data: any) {
        if (!_skipObserverSet.has(this) && !data.pingPong && !data.byteStreamOperation) {
            const msgType = identifyMessageType(data as Record<string, unknown>);
            observer.onInboundMessage?.(stream, msgType, data as Record<string, unknown>);
        }
        origDataReceived.call(this, stream, data);
    };

    const origWriteToStream = SrpcServer.prototype.writeToStream;
    SrpcServer.prototype.writeToStream = function (this: any, stream: any, data: any) {
        if (!_skipObserverSet.has(this) && !data.pingPong && !data.byteStreamOperation) {
            const msgType = identifyMessageType(data as Record<string, unknown>);
            observer.onOutboundMessage?.(stream, msgType, data as Record<string, unknown>);
        }
        origWriteToStream.call(this, stream, data);
    };
}

////////////////////////////////////////
// Mutex

function patchMutex(store: DevConsoleStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mutexModule = require('../helpers/redis/mutex');
    const { flattenMutexKey, MutexAcquisitionError } = mutexModule;
    const origWithMutex = mutexModule.withMutex;

    mutexModule.withMutex = function <T>(options: any): Promise<T> {
        const key = flattenMutexKey(options.key);
        const id = uuid7();
        const startedAt = Date.now();

        const entry: DevConsoleMutexEntry = {
            id,
            key,
            status: 'pending',
            startedAt
        };
        store.addMutexPending(entry);

        const wrappedOptions = {
            ...options,
            fn: async (didWait: boolean) => {
                store.updateMutexAcquired(id, didWait);
                try {
                    const result = await options.fn(didWait);
                    store.updateMutexReleased(id);
                    return result;
                } catch (err) {
                    store.updateMutexError(id, err);
                    throw err;
                }
            }
        };

        return origWithMutex(wrappedOptions).catch((err: any) => {
            if (err instanceof MutexAcquisitionError) {
                // Update the pending entry to failed
                const existing = store.activeMutexes.get(id);
                if (existing) {
                    existing.status = 'failed';
                    existing.error = err.message;
                    store.activeMutexes.delete(id);
                    store.onEvent?.('mutex:failed', existing);
                } else {
                    store.addMutexFailed({
                        id,
                        key,
                        status: 'failed',
                        startedAt,
                        error: err.message
                    });
                }
            }
            throw err;
        });
    };
}

////////////////////////////////////////
// Database

function patchDatabase(store: DevConsoleStore) {
    function startEntry(sql: string, params: any[]): DevConsoleDatabaseQueryEntry {
        const entry: DevConsoleDatabaseQueryEntry = {
            id: uuid7(),
            timestamp: Date.now(),
            sql,
            params,
            status: 'running'
        };
        store.addDatabaseQuery(entry);
        return entry;
    }

    function completeEntry(entry: DevConsoleDatabaseQueryEntry, error?: string) {
        entry.durationMs = Date.now() - entry.timestamp;
        if (error) {
            entry.status = 'error';
            entry.error = error;
        } else {
            entry.status = 'ok';
        }
        store.completeDatabaseQuery(entry);
    }

    // Patch writes: MySQLConnection.run() and PostgresConnection.run()
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MySQLConnection } = require('@deepkit/mysql');
        const origMysqlRun = MySQLConnection.prototype.run;
        MySQLConnection.prototype.run = async function (sql: string, params: any[] = []) {
            const entry = startEntry(sql, params);
            try {
                const result = await origMysqlRun.call(this, sql, params);
                completeEntry(entry);
                return result;
            } catch (err: any) {
                completeEntry(entry, err.message || String(err));
                throw err;
            }
        };
    } catch {
        // @deepkit/mysql not available
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PostgresConnection } = require('@deepkit/postgres');
        const origPgRun = PostgresConnection.prototype.run;
        PostgresConnection.prototype.run = async function (sql: string, params: any[] = []) {
            const entry = startEntry(sql, params);
            try {
                const result = await origPgRun.call(this, sql, params);
                completeEntry(entry);
                return result;
            } catch (err: any) {
                completeEntry(entry, err.message || String(err));
                throw err;
            }
        };
    } catch {
        // @deepkit/postgres not available
    }

    // Patch reads: SQLConnection.execAndReturnAll() and execAndReturnSingle()
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SQLConnection } = require('@deepkit/sql');
        const origExecAll = SQLConnection.prototype.execAndReturnAll;
        SQLConnection.prototype.execAndReturnAll = async function (sql: string, params?: any[]) {
            const entry = startEntry(sql, params ?? []);
            try {
                const result = await origExecAll.call(this, sql, params);
                completeEntry(entry);
                return result;
            } catch (err: any) {
                completeEntry(entry, err.message || String(err));
                throw err;
            }
        };

        const origExecSingle = SQLConnection.prototype.execAndReturnSingle;
        SQLConnection.prototype.execAndReturnSingle = async function (sql: string, params?: any[]) {
            const entry = startEntry(sql, params ?? []);
            try {
                const result = await origExecSingle.call(this, sql, params);
                completeEntry(entry);
                return result;
            } catch (err: any) {
                completeEntry(entry, err.message || String(err));
                throw err;
            }
        };
    } catch {
        // @deepkit/sql not available
    }
}

////////////////////////////////////////
// Error serialization helper

const SKIP_KEYS = new Set(['name', 'message', 'stack', 'cause']);

export function serializeError(err: unknown): DevConsoleErrorInfo {
    if (!(err instanceof Error)) {
        return { name: 'Error', message: String(err) };
    }

    const info: DevConsoleErrorInfo = {
        name: err.name,
        message: err.message,
        stack: err.stack
    };

    for (const key of Object.keys(err)) {
        if (SKIP_KEYS.has(key)) continue;
        info[key] = (err as any)[key];
    }

    const cause = (err as any).cause;
    if (cause instanceof Error) {
        info.cause = serializeError(cause);
    } else if (cause !== undefined) {
        info.cause = { name: 'Error', message: String(cause) };
    }

    return info;
}
