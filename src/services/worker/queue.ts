import { Queue } from 'bullmq';

import { getAppConfig } from '../../app/resolver';
import { createRedisOptions } from '../../helpers/redis/redis';

export class WorkerQueueRegistry {
    static registry = new Map<string, Queue>();

    static getDefaultQueue() {
        const appConfig = getAppConfig();
        return this.getQueue(appConfig.BULL_QUEUE);
    }

    static getQueue(name: string): Queue {
        if (!this.registry.has(name)) {
            const { options, prefix } = createRedisOptions('BULL');
            this.registry.set(
                name,
                new Queue(name, {
                    connection: options,
                    prefix: `${prefix}:bmq`
                })
            );
        }

        return this.registry.get(name)!;
    }

    static async closeQueues() {
        for (const queue of this.registry.values()) {
            await queue.close();
        }
        this.registry.clear();
    }
}
