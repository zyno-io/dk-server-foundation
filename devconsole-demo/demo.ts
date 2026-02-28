import { eventDispatcher } from '@deepkit/event';
import { ApplicationServer, onServerMainBootstrapDone } from '@deepkit/framework';
import { http, HttpBody, HttpNotFoundError } from '@deepkit/http';
import { ScopedLogger } from '@deepkit/logger';
import { ActiveRecord } from '@deepkit/orm';
import { AutoIncrement, entity, PrimaryKey } from '@deepkit/type';

import { ClientMessage, ServerMessage } from '../resources/proto/generated/test/test';
import { AutoStart, BaseAppConfig, createApp } from '../src/app';
import { onServerShutdownRequested } from '../src/app/shutdown';
import { createMySQLDatabase, createPersistedEntity } from '../src/database';
import { sleepSecs, uuid7, withMutex } from '../src/helpers';
import { BaseJob, WorkerJob, WorkerService } from '../src/services';
import { SrpcByteStream, SrpcClient, SrpcError, SrpcMeta, SrpcServer, SrpcStream } from '../src/srpc';

// ──────────────────────────────────────────────
// Entity & Database
// ──────────────────────────────────────────────

@entity.name('notes')
class Note extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    title!: string;
    body!: string;
    createdAt: Date = new Date();
}

interface NoteResponse {
    id: number;
    title: string;
    body: string;
    createdAt: Date;
}

class DemoDB extends createMySQLDatabase({}, [Note]) {}

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

class DemoConfig extends BaseAppConfig {
    SRPC_AUTH_SECRET = 'demo-secret';
    SRPC_AUTH_CLOCK_DRIFT_MS = 60_000;
}

// ──────────────────────────────────────────────
// HTTP Controller
// ──────────────────────────────────────────────

@http.controller('api')
class DemoController {
    constructor(private db: DemoDB) {}

    @http.GET('hello')
    hello(): { message: string; time: string } {
        return { message: 'Hello from dk-server-foundation demo!', time: new Date().toISOString() };
    }

    @http.GET('notes')
    async listNotes(): Promise<NoteResponse[]> {
        return this.db.query(Note).orderBy('createdAt', 'desc').find();
    }

    @http.GET('notes/:id')
    async getNote(id: number): Promise<NoteResponse> {
        const note = await this.db.query(Note).filter({ id }).findOneOrUndefined();
        if (!note) throw new HttpNotFoundError();
        return note;
    }

    @http.POST('notes')
    async createNote(body: HttpBody<{ title: string; body: string }>): Promise<NoteResponse> {
        const note = await createPersistedEntity(Note, {
            title: body.title,
            body: body.body
        });
        return note;
    }

    @http.DELETE('notes/:id')
    async deleteNote(id: number): Promise<{ deleted: boolean }> {
        const note = await this.db.query(Note).filter({ id }).findOneOrUndefined();
        if (!note) throw new HttpNotFoundError();
        await this.db.query(Note).filter({ id }).deleteOne();
        return { deleted: true };
    }

    @http.GET('error')
    throwError(): never {
        throw new Error('This is a deliberate test error');
    }

    @http.GET('slow')
    async slow(): Promise<{ message: string }> {
        await sleepSecs(2);
        return { message: 'Finally done!' };
    }
}

// ──────────────────────────────────────────────
// Worker Job
// ──────────────────────────────────────────────

@WorkerJob()
class GenerateNoteJob extends BaseJob<{ title: string }, { id: number }> {
    constructor(
        private logger: ScopedLogger,
        private db: DemoDB
    ) {
        super();
    }

    async handle(data: { title: string }) {
        this.logger.info('Generating note', { title: data.title });
        const note = await createPersistedEntity(Note, {
            title: data.title,
            body: `Auto-generated at ${new Date().toISOString()}`
        });
        return { id: note.id };
    }
}

// ──────────────────────────────────────────────
// SRPC Server + Client
// ──────────────────────────────────────────────

const SRPC_WS_PATH = '/srpc';

type TestClientOutput = ClientMessage;
type TestServerOutput = ServerMessage;

@AutoStart()
class SrpcDemoService {
    private server!: SrpcServer<SrpcMeta, TestClientOutput, TestServerOutput>;
    private client?: SrpcClient<TestClientOutput, TestServerOutput>;
    private connectedStream?: SrpcStream;
    private clientTrafficInterval?: ReturnType<typeof setInterval>;
    private serverTrafficInterval?: ReturnType<typeof setInterval>;

    constructor(
        private logger: ScopedLogger,
        private appServer: ApplicationServer
    ) {
        this.server = new SrpcServer<SrpcMeta, TestClientOutput, TestServerOutput>({
            logger: this.logger.scoped('SrpcServer'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: SRPC_WS_PATH,
            debug: false
        });

        this.setupServerHandlers();

        this.server.registerConnectionHandler(stream => {
            this.connectedStream = stream;
            this.logger.info('SRPC client connected', { clientId: stream.clientId });
        });

        this.server.registerDisconnectHandler((stream, cause) => {
            if (this.connectedStream?.id === stream.id) {
                this.connectedStream = undefined;
            }
            this.logger.info('SRPC client disconnected', { clientId: stream.clientId, cause });
        });
    }

    private get httpPort(): number {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this.appServer.getHttpWorker()['server']!.address() as any).port;
    }

    private setupServerHandlers() {
        // Echo handler
        this.server.registerMessageHandler('uEcho', async (_stream, data) => {
            return { message: `Echo: ${data.message}` };
        });

        // Complex data types handler
        this.server.registerMessageHandler('uComplex', async (_stream, data) => {
            const result = `Processed: ${data.stringField}, int=${data.intField}, bool=${data.boolField}`;
            const count = data.arrayField.length + Object.keys(data.mapField).length;
            return { result, count };
        });

        // Error handler
        this.server.registerMessageHandler('uError', async (_stream, data) => {
            throw new SrpcError(data.errorMessage, data.userError);
        });

        // Upload handler
        this.server.registerMessageHandler('uUpload', async (stream, data) => {
            const receiver = SrpcByteStream.createReceiver(stream, data.streamId);
            const chunks: Buffer[] = [];
            for await (const chunk of receiver) {
                chunks.push(chunk);
            }
            const totalBytes = Buffer.concat(chunks).length;
            return { message: `Uploaded ${data.filename}`, bytesReceived: totalBytes };
        });

        // Download handler
        this.server.registerMessageHandler('uDownload', async (stream, data) => {
            const testData = Buffer.from(`File contents for ${data.filename} - generated at ${new Date().toISOString()}`, 'utf-8');
            const sender = SrpcByteStream.createSender(stream);
            setTimeout(() => {
                sender.write(testData);
                sender.end();
            }, 10);
            return { streamId: sender.id, bytesTotal: testData.length };
        });

        // Slow request handler
        this.server.registerMessageHandler('uSlow', async (_stream, data) => {
            const start = Date.now();
            await new Promise(resolve => setTimeout(resolve, data.delayMs));
            return { message: 'Completed', actualDelayMs: Date.now() - start };
        });
    }

    startClient() {
        this.logger.info('Starting SRPC client (connecting to self)...');

        this.client = new SrpcClient<TestClientOutput, TestServerOutput>(
            this.logger.scoped('SrpcClient'),
            `ws://localhost:${this.httpPort}${SRPC_WS_PATH}`,
            ClientMessage,
            ServerMessage,
            `demo-client-${uuid7().slice(0, 8)}`,
            { role: 'demo', env: 'development' },
            'demo-secret'
        );

        // Register handler for server-initiated notify
        this.client.registerMessageHandler('dNotify', async data => {
            this.logger.info('Client received notification from server', { notification: data.notification });
            return { acknowledged: true };
        });

        // Register handler for server-initiated compute
        this.client.registerMessageHandler('dCompute', async data => {
            let result = data.number;
            if (data.operation === 'square') result = data.number * data.number;
            if (data.operation === 'double') result = data.number * 2;
            this.logger.info('Client computed result', { operation: data.operation, input: data.number, result });
            return { result };
        });

        this.client.registerConnectionHandler(() => {
            this.logger.info('SRPC client connected to server');
            this.startTrafficGeneration();
        });

        this.client.registerDisconnectHandler(() => {
            this.logger.info('SRPC client disconnected from server');
            this.stopTrafficGeneration();
        });

        this.client.connect();
    }

    private startTrafficGeneration() {
        // Client → Server traffic: echo every 8 seconds
        this.clientTrafficInterval = setInterval(async () => {
            if (!this.client?.isConnected) return;

            try {
                const messages = [
                    () => this.client!.invoke('uEcho', { message: `Ping at ${new Date().toLocaleTimeString()}` }),
                    () =>
                        this.client!.invoke('uComplex', {
                            stringField: 'demo',
                            intField: Math.floor(Math.random() * 100),
                            doubleField: Math.random() * 100,
                            boolField: Math.random() > 0.5,
                            arrayField: ['a', 'b', 'c'],
                            mapField: { key: 'value' }
                        }),
                    () => this.client!.invoke('uSlow', { delayMs: 50 })
                ];

                const pick = messages[Math.floor(Math.random() * messages.length)];
                await pick();
            } catch (err) {
                this.logger.debug('Client traffic error (expected occasionally)', { err: String(err) });
            }
        }, 8_000);

        // Server → Client traffic: notify/compute every 12 seconds
        this.serverTrafficInterval = setInterval(async () => {
            if (!this.connectedStream) return;

            try {
                const coin = Math.random();
                if (coin < 0.5) {
                    await this.server.invoke(this.connectedStream, 'dNotify', {
                        notification: `Server says hello at ${new Date().toLocaleTimeString()}`
                    });
                } else {
                    const num = Math.floor(Math.random() * 20) + 1;
                    const op = Math.random() > 0.5 ? 'square' : 'double';
                    await this.server.invoke(this.connectedStream, 'dCompute', { number: num, operation: op });
                }
            } catch (err) {
                this.logger.debug('Server traffic error (expected occasionally)', { err: String(err) });
            }
        }, 12_000);
    }

    private stopTrafficGeneration() {
        if (this.clientTrafficInterval) {
            clearInterval(this.clientTrafficInterval);
            this.clientTrafficInterval = undefined;
        }
        if (this.serverTrafficInterval) {
            clearInterval(this.serverTrafficInterval);
            this.serverTrafficInterval = undefined;
        }
    }

    shutdown() {
        this.stopTrafficGeneration();
        this.client?.disconnect();
        this.server.close();
    }
}

// ──────────────────────────────────────────────
// HTTP Traffic Generator
// ──────────────────────────────────────────────

@AutoStart()
class HttpTrafficGenerator {
    private interval?: ReturnType<typeof setInterval>;

    constructor(
        private logger: ScopedLogger,
        private appServer: ApplicationServer,
        private workerSvc: WorkerService
    ) {}

    private get httpPort(): number {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this.appServer.getHttpWorker()['server']!.address() as any).port;
    }

    start() {
        const base = `http://localhost:${this.httpPort}`;
        this.logger.info('Starting HTTP traffic generator', { base });

        // Generate HTTP traffic every 10 seconds
        this.interval = setInterval(async () => {
            try {
                const actions = [
                    async () => {
                        await fetch(`${base}/api/hello`);
                    },
                    async () => {
                        await fetch(`${base}/api/notes`);
                    },
                    async () => {
                        const res = await fetch(`${base}/api/notes`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ title: `Note ${Date.now()}`, body: 'Auto-generated by traffic generator' })
                        });
                        const note = (await res.json()) as { id: number };
                        // Sometimes fetch the note we just created
                        if (Math.random() > 0.5) {
                            await fetch(`${base}/api/notes/${note.id}`);
                        }
                    },
                    async () => {
                        // Hit the error endpoint occasionally
                        await fetch(`${base}/api/error`);
                    },
                    async () => {
                        // Queue a worker job
                        await this.workerSvc.queueJob(GenerateNoteJob, { title: `Worker Note ${Date.now()}` });
                    }
                ];

                const pick = actions[Math.floor(Math.random() * actions.length)];
                await pick();
            } catch {
                // Errors are expected (e.g., the error endpoint)
            }
        }, 10_000);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }
}

// ──────────────────────────────────────────────
// Mutex Traffic Generator
// ──────────────────────────────────────────────

@AutoStart()
class MutexTrafficGenerator {
    private interval?: ReturnType<typeof setInterval>;

    constructor(private logger: ScopedLogger) {}

    start() {
        this.logger.info('Starting mutex traffic generator');

        const mutexKeys = ['resource:alpha', 'resource:beta'];

        this.interval = setInterval(async () => {
            const key = mutexKeys[Math.floor(Math.random() * mutexKeys.length)];
            const holdMs = Math.floor(Math.random() * 5000) + 3000; // 3-8 seconds

            try {
                await withMutex({
                    key,
                    fn: async () => {
                        this.logger.debug('Mutex acquired', { key, holdMs });
                        await new Promise(resolve => setTimeout(resolve, holdMs));
                        this.logger.debug('Mutex released', { key });
                    }
                });
            } catch (err) {
                this.logger.debug('Mutex error (expected occasionally)', { key, err: String(err) });
            }
        }, 3_000);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }
}

// ──────────────────────────────────────────────
// Shutdown Listener
// ──────────────────────────────────────────────

class DemoShutdownListener {
    constructor(
        private srpcDemo: SrpcDemoService,
        private trafficGen: HttpTrafficGenerator,
        private mutexGen: MutexTrafficGenerator
    ) {}

    @eventDispatcher.listen(onServerShutdownRequested)
    async onShutdown() {
        this.trafficGen.stop();
        this.mutexGen.stop();
        this.srpcDemo.shutdown();
    }
}

// ──────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────

const app = createApp({
    config: DemoConfig,
    db: DemoDB,
    controllers: [DemoController],
    providers: [SrpcDemoService, HttpTrafficGenerator, MutexTrafficGenerator, GenerateNoteJob],
    listeners: [DemoShutdownListener],
    enableWorker: true,
    frameworkConfig: { port: 3000 }
});

app.listen(onServerMainBootstrapDone, async () => {
    // Ensure database table exists
    const db = app.get(DemoDB);
    try {
        await db.rawExecute(`
            CREATE TABLE IF NOT EXISTS \`notes\` (
                \`id\` int NOT NULL AUTO_INCREMENT,
                \`title\` varchar(255) NOT NULL,
                \`body\` longtext NOT NULL,
                \`createdAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
        `);
    } catch (err) {
        console.error('Failed to create notes table:', err);
    }

    // Start the SRPC client (connects back to our own server)
    const srpcDemo = app.get(SrpcDemoService);
    setTimeout(() => srpcDemo.startClient(), 500);

    // Start the HTTP traffic generator
    const trafficGen = app.get(HttpTrafficGenerator);
    setTimeout(() => trafficGen.start(), 1000);

    // Start the mutex traffic generator
    const mutexGen = app.get(MutexTrafficGenerator);
    setTimeout(() => mutexGen.start(), 1500);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  dk-server-foundation DevConsole Demo             ║');
    console.log('║                                                  ║');
    console.log('║  DevConsole:  http://localhost:3000/_devconsole/  ║');
    console.log('║  API:         http://localhost:3000/api/hello     ║');
    console.log('║  Notes CRUD:  http://localhost:3000/api/notes     ║');
    console.log('║                                                  ║');
    console.log('║  Traffic is auto-generated every ~10s             ║');
    console.log('║  SRPC client ↔ server chatter every ~8-12s       ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
});

app.run();
