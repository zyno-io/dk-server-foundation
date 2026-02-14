import { UniqueConstraintFailure } from '@deepkit/orm';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { Job, QueueEvents } from 'bullmq';

import { getAppConfig } from '../../app/resolver';
import { DBProvider } from '../../app/state';
import { createPersistedEntity, getDialect, tableExistsSql } from '../../database';
import { HealthcheckService } from '../../health/healthcheck.service';
import { createRedisOptions } from '../../helpers/redis/redis';
import { createLogger, ExtendedLogger } from '../logger';
import { JobEntity } from './entity';
import { WorkerQueueRegistry } from './queue';
import { BaseAppConfig } from '../../app';

export class WorkerObserverService {
    private appConfig: BaseAppConfig;
    private queueName: string;
    private logger: ExtendedLogger;
    private observer?: QueueEvents;
    private db = this.dbProvider.db;

    constructor(
        private hcSvc: HealthcheckService,
        private dbProvider: DBProvider
    ) {
        this.appConfig = getAppConfig();
        this.queueName = this.appConfig.BULL_QUEUE;
        this.logger = createLogger(this, { queueName: this.queueName });
    }

    async start() {
        await this.ensureTableExists();

        const { options, prefix } = createRedisOptions('BULL');
        this.observer = new QueueEvents(this.queueName, {
            connection: options,
            prefix: `${prefix}:bmq`
        });

        const queue = WorkerQueueRegistry.getQueue(this.appConfig.BULL_QUEUE);

        this.observer.on('added', args => {
            this.logger.info('Job added', {
                jobId: args.jobId,
                jobName: args.name
            });
        });
        this.observer.on('active', args => {
            this.logger.info('Job activated', { jobId: args.jobId });
        });
        this.observer.on('stalled', args => {
            this.logger.warn('Job stalled', { jobId: args.jobId });
        });
        this.observer.on('delayed', args => {
            this.logger.info('Job delayed', { jobId: args.jobId, delay: args.delay });
        });
        this.observer.on('completed', async args => {
            this.logger.info('Job completed', { jobId: args.jobId });
            const job = await queue.getJob(args.jobId);
            if (job) {
                await this.logJob(job, 'completed', args.returnvalue);
                await queue.remove(job.id!);
            }
        });
        this.observer.on('failed', async args => {
            this.logger.info('Job failed', { jobId: args.jobId });
            const job = await queue.getJob(args.jobId);
            if (job) {
                await this.logJob(job, 'failed', { reason: job.failedReason, stack: job.failedReason });
                await queue.remove(job.id!);
            }
        });
        this.observer.on('error', err => {
            this.logger.error('Observer error:', err);
        });

        this.logger.info('Observer started');

        const completedJobs = await queue.getCompleted();
        for (const job of completedJobs) {
            this.logger.info('Logging previously completed job', { jobId: job.id });
            await this.logJob(job, 'completed', job.returnvalue);
            await queue.remove(job.id!);
        }

        const failedJobs = await queue.getFailed();
        for (const job of failedJobs) {
            this.logger.error('Logging previously failed job', { jobId: job.id });
            await this.logJob(job, 'failed', { reason: job.failedReason, stack: job.stacktrace });
            await queue.remove(job.id!);
        }

        this.hcSvc.register('Worker Observer', async () => {
            if (!this.isRedisReady()) {
                throw new Error('Observer Redis connection is not ready');
            }
        });
    }

    private isRedisReady() {
        return this.observer?.['connection']['_client'].status === 'ready' || this.observer?.['connection']['_client'].status === 'wait';
    }

    private async ensureTableExists() {
        const dialect = getDialect(this.db.adapter as SQLDatabaseAdapter);
        const tableInfoRows = await this.db.rawQuery(tableExistsSql(dialect, '_jobs'));
        if (tableInfoRows.length) return;

        if (dialect === 'postgres') {
            await this.db.rawExecute(`
                CREATE TABLE "_jobs" (
                    "id" varchar(255) NOT NULL,
                    "queue" varchar(255) NOT NULL,
                    "queueId" varchar(255) NOT NULL,
                    "attempt" smallint NOT NULL,
                    "name" varchar(255) NOT NULL,
                    "data" jsonb DEFAULT NULL,
                    "traceId" char(32) DEFAULT NULL,
                    "status" varchar(20) NOT NULL CHECK ("status" IN ('completed','failed')),
                    "result" jsonb DEFAULT NULL,
                    "createdAt" timestamp NOT NULL,
                    "shouldExecuteAt" timestamp NOT NULL,
                    "executedAt" timestamp NOT NULL,
                    "completedAt" timestamp NOT NULL,
                    PRIMARY KEY ("id","attempt")
                );
            `);
        } else {
            await this.db.rawExecute(`
                CREATE TABLE \`_jobs\` (
                    \`id\` varchar(255) NOT NULL,
                    \`queue\` varchar(255) NOT NULL,
                    \`queueId\` varchar(255) NOT NULL,
                    \`attempt\` tinyint unsigned NOT NULL,
                    \`name\` varchar(255) NOT NULL,
                    \`data\` json DEFAULT NULL,
                    \`traceId\` char(32) DEFAULT NULL,
                    \`status\` enum('completed','failed') NOT NULL,
                    \`result\` json DEFAULT NULL,
                    \`createdAt\` datetime NOT NULL,
                    \`shouldExecuteAt\` datetime NOT NULL,
                    \`executedAt\` datetime NOT NULL,
                    \`completedAt\` datetime NOT NULL,
                    PRIMARY KEY (\`id\`,\`attempt\`)
                ) ENGINE=InnoDB;
            `);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async logJob(job: Job, status: 'completed' | 'failed', result: any) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const traceparent = (job.opts as any).traceparent;
            const traceId = traceparent ? traceparent.split('-')[1] : null;

            await createPersistedEntity(JobEntity, {
                id: `${this.queueName}:${job.id}`,
                queue: this.queueName,
                queueId: job.id!,
                attempt: job.attemptsMade,
                name: job.name,
                data: job.data,
                traceId,
                status,
                result,
                createdAt: new Date(job.timestamp),
                shouldExecuteAt: new Date(job.timestamp + (job.opts.delay ?? 0)),
                executedAt: new Date(job.processedOn!),
                completedAt: new Date(job.finishedOn!)
            });
        } catch (err) {
            if (err instanceof UniqueConstraintFailure) {
                this.logger.warn('Job already logged', { jobId: job.id });
            } else {
                throw err;
            }
        }
    }
}
