import { inspect } from 'util';

import { App } from '@deepkit/app';
import { HttpRouter } from '@deepkit/http';
import { ScopedLogger } from '@deepkit/logger';
import { ReflectionClass } from '@deepkit/type';

import { DevConsoleClientMessage, DevConsoleServerMessage, UReplCompleteItem } from '../../resources/proto/generated/devconsole/devconsole';
import { getAppConfig } from '../app/resolver';
import { DBProvider, globalState } from '../app/state';
import { getDialect, quoteId } from '../database/dialect';
import { HealthcheckService } from '../health/healthcheck.service';
import { getPackageName, getPackageVersion } from '../helpers/io/package';
import { buildReplContext } from '../services/cli/repl-context';
import { JobEntity } from '../services/worker/entity';
import { WorkerQueueRegistry } from '../services/worker/queue';
import { SrpcServer } from '../srpc/SrpcServer';
import { SrpcMeta } from '../srpc/types';
import { isLocalhostDirect } from './devconsole.middleware';
import { DevConsoleStore } from './devconsole.store';
import { skipDevConsoleObserver } from './patches';

type DCClientMsg = DevConsoleClientMessage;
type DCServerMsg = DevConsoleServerMessage;

const SECRET_MASK_PATTERNS = ['SECRET', 'PASSWORD', 'DSN', 'TOKEN', 'KEY'];

export function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
        const upperKey = key.toUpperCase();
        if (SECRET_MASK_PATTERNS.some(p => upperKey.includes(p)) && value) {
            masked[key] = '****';
        } else {
            masked[key] = value;
        }
    }
    return masked;
}

export class DevConsoleSrpcServer {
    private server: SrpcServer<SrpcMeta, DCClientMsg, DCServerMsg>;
    private replInitialized = false;

    private get store() {
        return DevConsoleStore.get()!;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private get app(): App<any> {
        return globalState.currentApp!;
    }

    constructor(logger: ScopedLogger) {
        this.server = new SrpcServer<SrpcMeta, DCClientMsg, DCServerMsg>({
            logger,
            clientMessage: DevConsoleClientMessage,
            serverMessage: DevConsoleServerMessage,
            wsPath: '/_devconsole/ws',
            debug: false,
            logLevel: false
        });

        skipDevConsoleObserver(this.server);

        // Skip HMAC auth but restrict to direct localhost connections.
        // Rejects requests forwarded through a reverse proxy.
        this.server.setClientAuthorizer(async (_meta, req) => {
            return isLocalhostDirect(req);
        });

        this.registerHandlers();
    }

    private registerHandlers() {
        const s = this.server;

        // REPL
        s.registerMessageHandler('uReplEval', async (_stream, data) => {
            return this.handleReplEval(data.code);
        });
        s.registerMessageHandler('uReplComplete', async (_stream, data) => {
            return this.handleReplComplete(data.code, data.cursorPos);
        });

        // Overview / Dashboard
        s.registerMessageHandler('uGetOverview', async () => {
            return {
                name: getPackageName() ?? '',
                version: getPackageVersion() ?? '',
                uptime: Date.now() - this.store.startedAt,
                env: process.env.APP_ENV ?? 'development',
                httpEntries: this.store.httpEntries.length,
                srpcMessages: this.store.srpcMessages.length,
                srpcActiveConnections: this.store.srpcConnections.size,
                srpcDisconnected: this.store.srpcDisconnected.length
            };
        });

        // Process info
        s.registerMessageHandler('uGetProcess', async () => {
            const mem = process.memoryUsage();
            const cpu = process.cpuUsage();
            return {
                pid: process.pid,
                rss: mem.rss,
                heapTotal: mem.heapTotal,
                heapUsed: mem.heapUsed,
                external: mem.external,
                arrayBuffers: mem.arrayBuffers,
                cpuUser: cpu.user,
                cpuSystem: cpu.system,
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            };
        });

        // Environment
        s.registerMessageHandler('uGetEnv', async () => {
            const config = getAppConfig();
            return { jsonData: JSON.stringify(maskSecrets(config as unknown as Record<string, unknown>)) };
        });

        // HTTP Requests
        s.registerMessageHandler('uGetRequests', async () => {
            return { jsonData: JSON.stringify(this.store.httpEntries.toArray().reverse()) };
        });

        // Routes
        s.registerMessageHandler('uGetRoutes', async () => {
            const router = this.app.get(HttpRouter);
            const routes = router
                .getRoutes()
                .filter(route => !route.getFullPath().startsWith('/_devconsole'))
                .map(route => ({
                    methods: route.httpMethods,
                    path: route.getFullPath(),
                    controller: route.action.type === 'controller' ? route.action.controller.name : undefined,
                    methodName: route.action.type === 'controller' ? route.action.methodName : undefined
                }));
            return { routes };
        });

        // sRPC connections
        s.registerMessageHandler('uGetSrpc', async () => {
            return {
                jsonData: JSON.stringify({
                    active: Array.from(this.store.srpcConnections.values()),
                    recentDisconnections: this.store.srpcDisconnected.toArray().reverse()
                })
            };
        });

        // sRPC messages
        s.registerMessageHandler('uGetSrpcMessages', async (_stream, data) => {
            let messages = this.store.srpcMessages.toArray();
            if (data.streamId) {
                messages = messages.filter(m => m.streamId === data.streamId);
            }
            return { jsonData: JSON.stringify(messages.reverse()) };
        });

        // Workers
        s.registerMessageHandler('uGetWorkers', async () => {
            const result: Record<string, unknown> = {};
            for (const [name, queue] of WorkerQueueRegistry.registry) {
                try {
                    result[name] = await queue.getJobCounts();
                } catch {
                    result[name] = { error: 'Failed to fetch job counts' };
                }
            }
            return { jsonData: JSON.stringify(result) };
        });

        // Workers jobs
        s.registerMessageHandler('uGetWorkersJobs', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const live: any[] = [];
            for (const [queueName, queue] of WorkerQueueRegistry.registry) {
                try {
                    const [active, waiting, delayed] = await Promise.all([queue.getActive(), queue.getWaiting(), queue.getDelayed()]);
                    for (const job of active) {
                        live.push({
                            id: `${queueName}:${job.id}`,
                            queue: queueName,
                            queueId: job.id,
                            name: job.name,
                            data: job.data,
                            status: 'active',
                            attempt: job.attemptsMade,
                            createdAt: job.timestamp,
                            shouldExecuteAt: job.timestamp + (job.opts.delay ?? 0),
                            executedAt: job.processedOn ?? null
                        });
                    }
                    for (const job of waiting) {
                        live.push({
                            id: `${queueName}:${job.id}`,
                            queue: queueName,
                            queueId: job.id,
                            name: job.name,
                            data: job.data,
                            status: 'waiting',
                            attempt: job.attemptsMade,
                            createdAt: job.timestamp,
                            shouldExecuteAt: job.timestamp + (job.opts.delay ?? 0),
                            executedAt: null
                        });
                    }
                    for (const job of delayed) {
                        live.push({
                            id: `${queueName}:${job.id}`,
                            queue: queueName,
                            queueId: job.id,
                            name: job.name,
                            data: job.data,
                            status: 'delayed',
                            attempt: job.attemptsMade,
                            createdAt: job.timestamp,
                            shouldExecuteAt: job.timestamp + (job.opts.delay ?? 0),
                            executedAt: null
                        });
                    }
                } catch {
                    // queue unavailable — skip
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let history: any[] = [];
            try {
                const dbProvider = this.app.get(DBProvider);
                const jobs = await dbProvider.db.query(JobEntity).orderBy('completedAt', 'desc').limit(200).find();
                history = jobs.map(j => ({
                    id: j.id,
                    queue: j.queue,
                    queueId: j.queueId,
                    name: j.name,
                    data: j.data,
                    status: j.status,
                    result: j.result,
                    attempt: j.attempt,
                    traceId: j.traceId,
                    createdAt: j.createdAt.getTime(),
                    shouldExecuteAt: j.shouldExecuteAt.getTime(),
                    executedAt: j.executedAt.getTime(),
                    completedAt: j.completedAt.getTime()
                }));
            } catch {
                // _jobs table may not exist if observer hasn't run
            }

            return { jsonData: JSON.stringify({ live, history }) };
        });

        // Database entities
        s.registerMessageHandler('uGetDatabaseEntities', async () => {
            try {
                const dbProvider = this.app.get(DBProvider);
                const db = dbProvider.db;
                const allEntities = db.entityRegistry.all();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const dialect = getDialect(db.adapter as any);

                const entities = allEntities
                    .map(entity => {
                        const reflection = ReflectionClass.from(entity);
                        const tableName = reflection.getCollectionName() || reflection.name || '';
                        const columns = reflection.getProperties().map(p => p.name);
                        const quotedTable = quoteId(dialect, tableName);
                        return { name: reflection.name ?? '', table: tableName, columns, quotedTable };
                    })
                    .sort((a, b) => a.name.localeCompare(b.name));
                return { entities };
            } catch {
                return { entities: [] };
            }
        });

        // Database query
        s.registerMessageHandler('uDatabaseQuery', async (_stream, data) => {
            const sql = data.sql.trim();
            if (!sql) {
                return { columns: [], rows: [], rowCount: 0, error: 'Empty query' };
            }

            try {
                const dbProvider = this.app.get(DBProvider);
                const isSelect = /^\s*(select|show|describe|explain|with)\b/i.test(sql);
                if (isSelect) {
                    const rawRows = await dbProvider.db.rawQuery(sql);
                    const columns = rawRows[0] ? Object.keys(rawRows[0]) : [];
                    const rows = (rawRows as Record<string, unknown>[]).map(row => ({
                        values: columns.map(col => (row[col] == null ? '' : String(row[col])))
                    }));
                    return { columns, rows, rowCount: rawRows.length };
                } else {
                    const result = await dbProvider.db.rawExecute(sql);
                    return { columns: [], rows: [], rowCount: 0, affectedRows: result.affectedRows };
                }
                // oxlint-disable-next-line typescript/no-explicit-any
            } catch (err: any) {
                return { columns: [], rows: [], rowCount: 0, error: err.message || String(err) };
            }
        });

        // Health checks
        s.registerMessageHandler('uGetHealthChecks', async () => {
            try {
                const hcSvc = this.app.get(HealthcheckService);
                const results = await hcSvc.checkIndividual();
                return { jsonData: JSON.stringify(results) };
            } catch {
                return { jsonData: JSON.stringify([]) };
            }
        });

        // Mutexes
        s.registerMessageHandler('uGetMutexes', async () => {
            return {
                jsonData: JSON.stringify({
                    active: Array.from(this.store.activeMutexes.values()),
                    history: this.store.mutexEntries.toArray().reverse()
                })
            };
        });
    }

    private ensureReplContext() {
        if (!this.replInitialized) {
            buildReplContext();
            this.replInitialized = true;
        }
    }

    private async handleReplEval(code: string): Promise<{ output: string; error?: string }> {
        this.ensureReplContext();

        // Capture console output without mutating the global console object.
        // We wrap the eval in a Function that shadows `console` with a local
        // capturing instance, avoiding race conditions with concurrent requests.
        const logs: string[] = [];
        const capture = (...args: unknown[]) =>
            logs.push(args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 4, colors: false }))).join(' '));
        const localConsole = { log: capture, warn: capture, error: capture, info: capture, debug: capture };

        try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
            const fn = new Function('console', `return eval(${JSON.stringify(code)})`);
            let result = fn(localConsole);
            if (result && typeof result === 'object' && typeof result.then === 'function') {
                result = await result;
            }

            const resultStr = result === undefined ? '' : inspect(result, { depth: 4, colors: false });
            const output = [...logs, resultStr].filter(Boolean).join('\n');
            return { output };
        } catch (err: unknown) {
            const output = logs.length > 0 ? logs.join('\n') : '';
            const errorStr = err instanceof Error ? (err.stack ?? err.message) : String(err);
            return { output, error: errorStr };
        }
    }

    private handleReplComplete(code: string, cursorPos: number): { items: UReplCompleteItem[]; replaceStart: number; replaceEnd: number } {
        this.ensureReplContext();

        const textBeforeCursor = code.slice(0, cursorPos);

        // Match expression like: identifier.chain.of.props.partialNa
        // or just: partialNa
        const exprMatch = textBeforeCursor.match(/((?:\$\$?|[a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*)*(?:\.\w*)?)$/);
        if (!exprMatch) {
            return { items: [], replaceStart: cursorPos, replaceEnd: cursorPos };
        }

        const fullExpr = exprMatch[1];
        const parts = fullExpr.split('.');
        const prefix = parts.pop() ?? '';
        const replaceStart = cursorPos - prefix.length;

        let target: unknown;

        if (parts.length === 0) {
            // Completing a top-level name — offer globals
            const items: UReplCompleteItem[] = [];
            const globals = [
                '$',
                '$$',
                'console',
                'process',
                'require',
                'global',
                'setTimeout',
                'setInterval',
                'Promise',
                'JSON',
                'Math',
                'Date',
                'Array',
                'Object',
                'String',
                'Number',
                'Boolean',
                'Map',
                'Set',
                'RegExp',
                'Error',
                'Buffer',
                'parseInt',
                'parseFloat',
                'undefined',
                'null',
                'true',
                'false',
                'async',
                'await'
            ];
            for (const name of globals) {
                if (name.startsWith(prefix)) {
                    items.push({ label: name, kind: 'global' });
                }
            }
            return { items: items.slice(0, 50), replaceStart, replaceEnd: cursorPos };
        }

        // Resolve the object chain before the final dot
        try {
            // eslint-disable-next-line no-eval
            target = eval(parts.join('.'));
        } catch {
            return { items: [], replaceStart, replaceEnd: cursorPos };
        }

        if (target == null) {
            return { items: [], replaceStart, replaceEnd: cursorPos };
        }

        const items = collectProperties(target, prefix);
        return { items: items.slice(0, 50), replaceStart, replaceEnd: cursorPos };
    }

    broadcast(type: string, data: unknown) {
        const jsonData = JSON.stringify(data);
        for (const stream of this.server.streamsById.values()) {
            this.server.invoke(stream, 'dEvent', { type, jsonData }).catch(() => {
                // fire-and-forget: ignore errors from individual clients
            });
        }
    }

    close() {
        this.server.close();
    }
}

export function collectProperties(obj: unknown, prefix: string): UReplCompleteItem[] {
    const seen = new Set<string>();
    const items: UReplCompleteItem[] = [];

    let current = obj;
    while (current != null) {
        for (const name of Object.getOwnPropertyNames(current)) {
            if (name.startsWith(prefix) && !seen.has(name) && !name.startsWith('__')) {
                seen.add(name);
                let kind = 'property';
                try {
                    const desc = Object.getOwnPropertyDescriptor(current, name);
                    if (desc && typeof desc.value === 'function') {
                        kind = 'method';
                    } else if (desc && (desc.get || desc.set)) {
                        kind = 'accessor';
                    }
                } catch {
                    // ignore
                }
                items.push({ label: name, kind });
            }
        }
        current = Object.getPrototypeOf(current);
        // Stop at Object.prototype to avoid noise
        if (current === Object.prototype) break;
    }

    // Sort: exact prefix match first, then alphabetical
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
}
