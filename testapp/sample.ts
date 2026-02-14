import { eventDispatcher } from '@deepkit/event';
import { ApplicationServer, onServerShutdown } from '@deepkit/framework';
import { http, HttpBody, UploadedFile } from '@deepkit/http';
import { Logger, ScopedLogger } from '@deepkit/logger';
import { ActiveRecord } from '@deepkit/orm';
import { assert, AutoIncrement, entity, PrimaryKey } from '@deepkit/type';

import { AutoStart, BaseAppConfig, createApp } from '../src/app';
import { onServerShutdownRequested } from '../src/app/shutdown';
import { createMySQLDatabase, createPersistedEntity } from '../src/database';
import { sleepSecs } from '../src/helpers';
import { BaseJob, ExtendedLogger, WorkerJob, WorkerService } from '../src/services';
import { withRootSpan } from '../src/telemetry';
import { SrpcTesterService } from './srpc-test';

@entity.name('sample')
class SampleEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
}

class SampleDB extends createMySQLDatabase({}, [SampleEntity]) {}

@http.controller('test-controller')
class SampleController {
    constructor(
        private db: SampleDB,
        private workerSvc: WorkerService
    ) {}

    @http.POST()
    async hello(
        body: HttpBody<{
            field1: string;
            field2: string;
            file1: UploadedFile;
        }>
    ): Promise<{ field1: string; field2: string; file1: { size: number } }> {
        await this.db.rawExecute(`DROP TABLE IF EXISTS sample`);
        await this.db.rawExecute(`
            CREATE TABLE \`sample\` (
                \`id\` int NOT NULL AUTO_INCREMENT,
                \`name\` longtext NOT NULL,
                PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
        `);

        await this.db.transaction(async txn => {
            await createPersistedEntity(
                SampleEntity,
                {
                    name: 'Test'
                },
                txn
            );
            await txn.query(SampleEntity).find();
        });

        await SampleEntity.query().deleteMany();

        await this.workerSvc.queueJob(SampleJob, { name: 'Other World' });

        return body;
    }
}

@WorkerJob()
class SampleJob extends BaseJob<{ name: string }, { output: string }> {
    constructor(private logger: ScopedLogger) {
        super();
    }

    async handle(data: { name: string }) {
        await SampleEntity.query().patchMany({ name: data.name });
        return { output: '123' };
    }
}

// Test that ExtendedLogger can be injected via constructor
class LoggerInjectionTest {
    constructor(
        private extendedLogger: ExtendedLogger,
        private baseLogger: Logger
    ) {
        // Verify ExtendedLogger is properly injected
        if (!(extendedLogger instanceof ExtendedLogger)) {
            throw new Error('ExtendedLogger injection failed: not an instance of ExtendedLogger');
        }
        // Verify Logger is also ExtendedLogger
        if (!(baseLogger instanceof ExtendedLogger)) {
            throw new Error('Logger injection failed: not an instance of ExtendedLogger');
        }
        console.log('✓ ExtendedLogger injection test passed');
    }
}

@AutoStart()
class TesterService {
    constructor(
        private logger: ScopedLogger,
        private db: SampleDB,
        private srpcTester: SrpcTesterService,
        private loggerTest: LoggerInjectionTest,
        private appServer: ApplicationServer
    ) {
        setTimeout(
            () =>
                this.runTests()
                    .then(() => this.waitForSrpcTests())
                    .then(() => sleepSecs(2))
                    .then(() => {
                        this.logger.info('All tests completed successfully! Sending SIGTERM...');
                        process.kill(process.pid, 'SIGTERM');
                    })
                    .catch(err => {
                        this.logger.error('Tests failed:', err);
                        process.exit(1);
                    }),
            1000
        );
    }

    async waitForSrpcTests() {
        this.logger.info('Waiting for SRPC tests to complete...');
        const maxWait = 30000; // 30 seconds max
        const start = Date.now();

        while (!this.srpcTester.testsCompleted && !this.srpcTester.testsFailed) {
            if (Date.now() - start > maxWait) {
                throw new Error('SRPC tests timed out');
            }
            await sleepSecs(0.1);
        }

        if (this.srpcTester.testsFailed) {
            throw new Error('SRPC tests failed');
        }
    }

    private get httpPort(): number {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this.appServer.getHttpWorker()['server']!.address() as any).port;
    }

    async runTests() {
        this.logger.info('Running tests...');

        await withRootSpan('server-test', async () => {
            const postBody = new FormData();
            postBody.append('_payload', JSON.stringify({ field1: 'value1' }));
            postBody.append('field2', 'value2');
            postBody.append('file1', new Blob(['file content']), 'file.txt');
            const result = await fetch(`http://localhost:${this.httpPort}/test-controller`, {
                method: 'POST',
                body: postBody
            });

            const body = await result.json();
            assert<{
                field1: 'value1';
                field2: 'value2';
                file1: { size: 12 };
            }>(body);

            await sleepSecs(1);

            const jobs = await this.db.rawQuery('SELECT * FROM _jobs ORDER BY createdAt DESC LIMIT 1');
            assert<{ name: 'SampleJob'; data: { name: 'Other World' }; result: { output: '123' }; status: 'completed'; traceId: string }>(jobs[0]);
        });

        this.logger.info('Done.');
    }
}

class ShutdownTestListener {
    private shutdownRequested = false;
    private shutdownRequestedAt = 0;

    constructor(private logger: Logger) {}

    @eventDispatcher.listen(onServerShutdownRequested)
    async onShutdownRequested() {
        this.logger.info('✓ onServerShutdownRequested fired');
        this.shutdownRequested = true;
        this.shutdownRequestedAt = Date.now();
        await sleepSecs(0.6);
    }

    @eventDispatcher.listen(onServerShutdown)
    onShutdown() {
        if (!this.shutdownRequested) {
            this.logger.error('✗ onServerShutdownRequested was NOT fired before onServerShutdown');
            process.exit(1);
        }

        const elapsed = Date.now() - this.shutdownRequestedAt;
        if (elapsed < 500) {
            this.logger.error(`✗ onServerShutdownRequested handler was not awaited (elapsed: ${elapsed}ms)`);
            process.exit(1);
        }

        this.logger.info(`✓ onServerShutdownRequested was fired and awaited before onServerShutdown (elapsed: ${elapsed}ms)`);
    }
}

export class AppConfig extends BaseAppConfig {
    SRPC_AUTH_SECRET = 'secret';
    SRPC_AUTH_CLOCK_DRIFT_MS = 60_000;
}

const app = createApp({
    config: AppConfig,
    db: SampleDB,
    controllers: [SampleController],
    providers: [TesterService, SampleJob, SrpcTesterService, LoggerInjectionTest],
    listeners: [ShutdownTestListener],
    enableWorker: true,
    frameworkConfig: { port: 0 }
});
app.run();
