import { Worker } from 'bullmq';
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { disconnectAllRedis, sleepMs } from '../../src';
import { DBProvider } from '../../src/app/state';
import { createRedisOptions } from '../../src/helpers/redis/redis';
import { JobEntity } from '../../src/services/worker/entity';
import { WorkerQueueRegistry } from '../../src/services/worker/queue';
import { WorkerRecorderService } from '../../src/services/worker/recorder';
import { forEachAdapter } from '../shared/db';

describe('WorkerRecorderService job recording', () => {
    const queueName = `test-recorder-${process.pid}`;

    forEachAdapter(({ createFacade }) => {
        // Set Redis and BULL_QUEUE before facade starts so getAppConfig() picks them up
        process.env.REDIS_HOST ??= 'localhost';
        process.env.REDIS_PORT ??= '6379';
        process.env.BULL_QUEUE = queueName;

        const tf = createFacade({ entities: [JobEntity] });

        let recorder: WorkerRecorderService;
        let bullWorker: Worker;

        before(
            async () => {
                await tf.start();

                const db = tf.getDb();
                const dbProvider = new DBProvider(db);
                recorder = new WorkerRecorderService(dbProvider);
                await recorder.ensureTableExists();
                await recorder.start();

                // Create a BullMQ worker that processes test jobs
                const { options, prefix } = createRedisOptions('BULL');
                bullWorker = new Worker(
                    queueName,
                    async job => {
                        if (job.name === 'failingJob') {
                            throw new Error('intentional failure');
                        }
                        return { echo: job.data.input };
                    },
                    { connection: options, prefix: `${prefix}:bmq` }
                );
            },
            { timeout: 15_000 }
        );

        after(
            async () => {
                await recorder?.stop();
                await bullWorker?.close();
                await WorkerQueueRegistry.closeQueues();
                await tf.stop();
                await disconnectAllRedis();
            },
            { timeout: 15_000 }
        );

        it('records a completed job to the _jobs table', async () => {
            const queue = WorkerQueueRegistry.getQueue(queueName);
            await queue.add('testJob', { input: 'hello' });

            // Wait for the recorder to process the completed event
            await sleepMs(2000);

            const db = tf.getDb();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rows: any[] = await db.rawQuery(`SELECT * FROM _jobs WHERE name = 'testJob'`);

            assert.ok(rows.length > 0, 'Expected at least one job record in _jobs table');
            const row = rows[0];
            assert.strictEqual(row.name, 'testJob');
            assert.strictEqual(row.status, 'completed');
            assert.strictEqual(row.queue, queueName);
        });

        it('records a failed job to the _jobs table', async () => {
            const queue = WorkerQueueRegistry.getQueue(queueName);
            await queue.add('failingJob', { input: 'fail' }, { attempts: 1 });

            // Wait for the recorder to process the failed event
            await sleepMs(2000);

            const db = tf.getDb();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rows: any[] = await db.rawQuery(`SELECT * FROM _jobs WHERE name = 'failingJob'`);

            assert.ok(rows.length > 0, 'Expected at least one failed job record in _jobs table');
            const row = rows[0];
            assert.strictEqual(row.name, 'failingJob');
            assert.strictEqual(row.status, 'failed');
        });

        it('recorder stop is idempotent', async () => {
            const db = tf.getDb();
            const dbProvider = new DBProvider(db);
            const tmpRecorder = new WorkerRecorderService(dbProvider);
            // stop without start should not throw
            await tmpRecorder.stop();
            await tmpRecorder.stop();
        });
    });
});
