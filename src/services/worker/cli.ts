import { cli } from '@deepkit/app';

import { CliServiceCommand } from '../cli';
import { WorkerObserverService } from './observer';
import { WorkerQueueRegistry } from './queue';
import { WorkerRunnerService } from './runner';
import { BaseJob } from './types';

@cli.controller('worker:start', {
    description: 'Start the worker runner and observer'
})
export class WorkerStartCommand extends CliServiceCommand {
    constructor(
        private runner: WorkerRunnerService,
        private observer: WorkerObserverService
    ) {
        super();
    }

    async startService() {
        await this.runner.start();
        await this.observer.start();
    }
}

@cli.controller('worker:runner', {
    description: 'Start the worker runner'
})
export class WorkerStartRunnerCommand extends CliServiceCommand {
    constructor(private runner: WorkerRunnerService) {
        super();
    }

    async startService() {
        await this.runner.start();
    }
}

@cli.controller('worker:observer', {
    description: 'Start the worker observer'
})
export class WorkerStartObserverCommand extends CliServiceCommand {
    constructor(private observer: WorkerObserverService) {
        super();
    }

    async startService() {
        await this.observer.start();
    }
}

@cli.controller('worker:queue', {
    // todo: optional queue name?
    description: 'Queue a job by name'
})
export class WorkerQueueJobCommand {
    async execute(jobName: string, data?: string) {
        data = data ? JSON.parse(data) : {};
        const queue = WorkerQueueRegistry.getQueue(BaseJob.QUEUE_NAME);
        await queue.add(jobName, data);
        await WorkerQueueRegistry.closeQueues();
    }
}
