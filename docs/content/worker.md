# Workers

Background job processing using BullMQ with Redis. Jobs are defined as classes, automatically discovered, and executed by a worker runner with full dependency injection.

## Setup

Enable the worker system in `createApp()`:

```typescript
const app = createApp({
    config: AppConfig,
    db: AppDB,
    enableWorker: true
});
```

This registers the job runner, observer, queue registry, and CLI commands. In development, the runner and observer auto-start. In production, they're controlled via `ENABLE_JOB_RUNNER` and `ENABLE_JOB_OBSERVER` environment variables.

## Defining Jobs

```typescript
import { BaseJob, WorkerJob } from '@signal24/dk-server-foundation';

@WorkerJob()
class SendEmailJob extends BaseJob<{ to: string; subject: string; body: string }> {
    async handle(data) {
        await emailProvider.send(data.to, data.subject, data.body);
    }
}
```

### With Return Values

```typescript
@WorkerJob()
class ProcessImageJob extends BaseJob<{ url: string }, { width: number; height: number }> {
    async handle(data) {
        const result = await processImage(data.url);
        return { width: result.width, height: result.height };
    }
}
```

### Cron Jobs

```typescript
@WorkerJob()
class DailyCleanupJob extends BaseJob {
    static CRON_SCHEDULE = '0 0 * * *'; // Midnight daily

    async handle() {
        await cleanupExpiredSessions();
    }
}
```

### Custom Queue

```typescript
@WorkerJob()
class HighPriorityJob extends BaseJob<{ data: string }> {
    static QUEUE_NAME = 'high-priority';

    async handle(data) {
        // Processed by a separate queue
    }
}
```

## `BaseJob<I, O>`

Abstract base class for all jobs.

| Static Property | Type             | Default     | Description                         |
| --------------- | ---------------- | ----------- | ----------------------------------- |
| `QUEUE_NAME`    | `string`         | `'default'` | BullMQ queue name                   |
| `CRON_SCHEDULE` | `string \| null` | `null`      | Cron expression for repeatable jobs |

| Method                        | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `handle(data: I): Promise<O>` | Job execution logic. Receives the queued data and returns the result. |

## Queueing Jobs

```typescript
import { WorkerService } from '@signal24/dk-server-foundation';

class OrderService {
    constructor(private workerSvc: WorkerService) {}

    async createOrder(order: Order) {
        // ... create order ...

        // Queue email notification
        await this.workerSvc.queueJob(SendEmailJob, {
            to: order.email,
            subject: 'Order Confirmation',
            body: `Your order #${order.id} has been placed.`
        });
    }
}
```

### Queue Options

```typescript
await workerSvc.queueJob(SendEmailJob, data, {
    delay: 5000, // Delay execution by 5 seconds
    priority: 1, // Lower number = higher priority
    attempts: 3, // Retry up to 3 times on failure
    backoff: {
        // Backoff strategy for retries
        type: 'exponential',
        delay: 1000
    },
    jobId: 'unique-id' // Deduplicate by job ID
});
```

### Jest Environment

In Jest, jobs are **not queued** -- `queueJob()` is a no-op. This prevents background job side effects during testing.

## Worker Runner

The `WorkerRunnerService` discovers all `@WorkerJob()` decorated classes, registers cron schedules, and processes jobs with full Deepkit dependency injection.

### Starting Manually

```bash
# Via CLI
node app.js worker:start
```

### Auto-Start (Development)

In development, the runner and observer start automatically if `ENABLE_JOB_RUNNER` is not explicitly set to `false`.

## Job Observer

The `WorkerObserverService` monitors BullMQ queue events and logs job lifecycle to the `_jobs` database table. It tracks:

- Job added, active, completed, failed
- Execution duration
- Error messages for failed jobs

The `_jobs` table is created automatically if it doesn't exist.

## Queue Registry

The `WorkerQueueRegistry` manages BullMQ queue instances as singletons:

```typescript
import { WorkerQueueRegistry } from '@signal24/dk-server-foundation';

const queue = WorkerQueueRegistry.getQueue('default');
const defaultQueue = WorkerQueueRegistry.getDefaultQueue();

// Cleanup on shutdown
await WorkerQueueRegistry.closeQueues();
```

## Configuration

| Variable              | Type      | Default      | Description           |
| --------------------- | --------- | ------------ | --------------------- |
| `BULL_REDIS_HOST`     | `string`  | —            | Redis host for BullMQ |
| `BULL_REDIS_PORT`     | `number`  | —            | Redis port for BullMQ |
| `BULL_REDIS_PREFIX`   | `string`  | —            | Redis key prefix      |
| `BULL_QUEUE`          | `string`  | `default`    | Default queue name    |
| `ENABLE_JOB_RUNNER`   | `boolean` | `true` (dev) | Enable job runner     |
| `ENABLE_JOB_OBSERVER` | `boolean` | `true` (dev) | Enable job observer   |

Falls back to default `REDIS_*` settings if `BULL_REDIS_*` is not set.
