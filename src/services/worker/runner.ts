import { SpanContext } from '@opentelemetry/api';
import { Job, Queue, Worker } from 'bullmq';

import { BaseAppConfig } from '../../app';
import { getAppConfig, resolveDeep } from '../../app/resolver';
import { DBProvider } from '../../app/state';
import { HealthcheckService } from '../../health/healthcheck.service';
import { sleepSecs, withContextData } from '../../helpers';
import { getRegisteredClasses } from '../../helpers/framework/decorators';
import { createRedisOptions } from '../../helpers/redis/redis';
import { getTraceContext, setSpanAttributes, withRootSpan } from '../../telemetry';
import { LeaderService } from '../leader';
import { createLogger, ExtendedLogger } from '../logger';
import { WorkerQueueRegistry } from './queue';
import { WorkerRecorderService } from './recorder';
import { JobClass, WorkerSymbol } from './types';

export class WorkerRunnerService {
    private appConfig: BaseAppConfig;
    private queueName: string;
    private logger: ExtendedLogger;
    private worker?: Worker;
    private queue?: Queue;
    private jobHandlers = new Map<string, InstanceType<JobClass>>();
    private runningJob?: Job;
    private recorder?: WorkerRecorderService;
    private leader?: LeaderService;

    constructor(
        private hcSvc: HealthcheckService,
        private dbProvider: DBProvider
    ) {
        this.appConfig = getAppConfig();
        this.queueName = this.appConfig.BULL_QUEUE;
        this.logger = createLogger(this, { queue: this.queueName });
    }

    async start() {
        this.queue = WorkerQueueRegistry.getQueue(this.queueName);

        const allJobClasses = getRegisteredClasses<JobClass>(WorkerSymbol);

        for (const jobClass of allJobClasses) {
            if (jobClass.QUEUE_NAME === this.queueName) {
                this.logger.info('Registering job', { id: { name: jobClass.name, schedule: jobClass.CRON_SCHEDULE } });

                const handlerInstance = resolveDeep(jobClass);
                if (!handlerInstance) throw new Error(`Cannot resolve job handler: ${jobClass.name}`);
                this.jobHandlers.set(jobClass.name, handlerInstance);

                if (jobClass.CRON_SCHEDULE) {
                    this.queue.add(jobClass.name, {}, { repeat: { pattern: jobClass.CRON_SCHEDULE } });
                }
            }
        }

        const { options, prefix } = createRedisOptions('BULL');

        this.worker = new Worker(
            this.queueName,
            async job =>
                this.withJobSpan(job, () =>
                    withContextData(
                        {
                            job: {
                                queue: this.queueName,
                                id: job.id,
                                name: job.name
                            },
                            traceId: getTraceContext()?.traceId
                        },
                        async () => {
                            const handler = this.jobHandlers.get(job.name);
                            if (!handler) {
                                throw new Error(`Job ${job.name} is not registered`);
                            }
                            try {
                                this.runningJob = job;
                                return await handler.handle(job.data);
                            } finally {
                                this.runningJob = undefined;
                            }
                        }
                    )
                ),
            {
                concurrency: 1,
                connection: options,
                prefix: `${prefix}:bmq`
            }
        );

        this.worker.on('active', job => {
            this.logger.info('Job activated', { job: { name: job.name, id: job.id } });
        });
        this.worker.on('completed', job => {
            this.logger.info('Job completed', { job: { name: job.name, id: job.id } });
        });
        this.worker.on('failed', (job, err) => {
            this.logger.error(`Job failed: ${err.message}`, err, { job: job ? { name: job.name, id: job.id } : undefined });
        });
        this.worker.on('stalled', jobId => {
            this.logger.warn('Job stalled', { jobId });
        });
        this.worker.on('error', err => {
            this.logger.error('Worker error', err);
        });
        this.worker.on('ready', () => {
            this.logger.info('Worker ready');
        });
        this.logger.info('Worker started');

        this.hcSvc.register('Worker Runner', async () => {
            if (!this.isRedisReady()) {
                throw new Error('Worker Redis connection is not ready');
            }
        });

        // Set up recorder with leader election
        this.recorder = new WorkerRecorderService(this.dbProvider);
        await this.recorder.ensureTableExists();

        this.leader = new LeaderService('worker-recorder');
        this.leader.setBecameLeaderCallback(async () => {
            this.logger.info('This runner is now the recorder leader');
            await this.recorder!.start();
        });
        this.leader.setLostLeaderCallback(async () => {
            this.logger.info('This runner lost recorder leadership');
            await this.recorder!.stop();
        });
        this.leader.start();
    }

    private async withJobSpan<T>(job: Job, fn: () => Promise<T>) {
        if (job.repeatJobKey) {
            let innerSpan: SpanContext | undefined;
            const result = await withRootSpan(`Job ${job.name}`, { jobId: job.id, schedulerTrace: getTraceContext()?.traceId }, () => {
                innerSpan = getTraceContext();
                return fn();
            });
            if (innerSpan) setSpanAttributes({ jobTraceId: innerSpan.traceId });
            return result;
        } else {
            return fn();
        }
    }

    private isRedisReady() {
        return this.worker?.['blockingConnection']['_client'].status === 'ready' || this.worker?.['blockingConnection']['_client'].status === 'wait';
    }

    async shutdown() {
        // Stop leader election first (releases Redis lock)
        if (this.leader) {
            await this.leader.stop();
        }

        // Explicitly stop recorder (LeaderService.stop() does NOT call lostLeaderCallback)
        if (this.recorder) {
            await this.recorder.stop();
        }

        // there's something crazy going on with worker shutdown when it hasn't successfully connected to Redis
        if (this.isRedisReady()) {
            await this.worker?.pause(true);

            while (this.runningJob) {
                this.logger.warn('Waiting for job to finish', { job: { name: this.runningJob.name, id: this.runningJob.id } });
                await sleepSecs(1);
            }

            await this.worker?.close();
        } else {
            this.worker?.close(true);
            this.worker?.disconnect();
        }
    }
}
