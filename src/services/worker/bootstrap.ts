import { App } from '@deepkit/app';
import { eventDispatcher } from '@deepkit/event';
import { onServerMainBootstrapDone, onServerShutdown } from '@deepkit/framework';
import { Redis } from 'ioredis';

import { isDevelopment } from '../../app/const';
import { getAppConfig } from '../../app/resolver';
import { globalState } from '../../app/state';
import { WorkerQueueJobCommand, WorkerStartCommand } from './cli';
import { JobEntity } from './entity';
import { WorkerQueueRegistry } from './queue';
import { WorkerRunnerService } from './runner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installWorkerComponents(app: App<any>) {
    globalState.enableWorker = true;
    globalState.additionalEntities.push(JobEntity);

    app.appModule.addProvider(WorkerRunnerService);

    app.appModule.addController(WorkerStartCommand);
    app.appModule.addController(WorkerQueueJobCommand);

    class WorkerListener {
        constructor(private runner: WorkerRunnerService) {}

        @eventDispatcher.listen(onServerShutdown)
        async shutdownRunner() {
            await this.runner.shutdown();

            // prevent new Redis connections from being created after shutdown
            // some issue in dev keeping processes alive forever
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (Redis.prototype as any).connect = () => {};
        }

        // we want this to run very late in the process, after the worker has shut down
        @eventDispatcher.listen(onServerShutdown, 1000)
        async closeQueues() {
            await WorkerQueueRegistry.closeQueues();
        }
    }
    app.appModule.addListener(WorkerListener);

    app.listen(onServerMainBootstrapDone, () => {
        if (!globalState.isCliService) {
            setTimeout(() => {
                const config = getAppConfig();
                if (config.ENABLE_JOB_RUNNER ?? isDevelopment) app.get(WorkerRunnerService).start();
            }, 1000);
        }
    });
}
