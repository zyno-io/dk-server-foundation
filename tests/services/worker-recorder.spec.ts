import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach, mock } from 'node:test';

import { disconnectAllRedis, LeaderService, sleepMs, TestingHelpers } from '../../src';

describe('WorkerRecorderService leader election', () => {
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379
        }
    });

    before(() => tf.start());
    after(async () => {
        await tf.stop();
        await disconnectAllRedis();
    });

    const FAST_OPTIONS = {
        ttlMs: 2000,
        renewalIntervalMs: 500,
        retryDelayMs: 200
    };

    let leaders: LeaderService[];

    afterEach(async () => {
        await Promise.all(leaders.map(l => l.stop()));
    });

    function setup() {
        leaders = [];
    }

    it('leader election picks one recorder among multiple candidates', async () => {
        setup();
        const becameLeader1 = mock.fn();
        const becameLeader2 = mock.fn();

        const leader1 = new LeaderService('recorder-elect-1', FAST_OPTIONS);
        leader1.setBecameLeaderCallback(becameLeader1);
        leaders.push(leader1);

        const leader2 = new LeaderService('recorder-elect-1', FAST_OPTIONS);
        leader2.setBecameLeaderCallback(becameLeader2);
        leaders.push(leader2);

        leader1.start();
        await sleepMs(300);
        leader2.start();
        await sleepMs(500);

        const totalLeaders = becameLeader1.mock.callCount() + becameLeader2.mock.callCount();
        assert.strictEqual(totalLeaders, 1, 'Only one leader should have been elected');
    });

    it('leadership transfers when leader stops (another runner takes over recording)', async () => {
        setup();
        const becameLeader1 = mock.fn();
        const becameLeader2 = mock.fn();

        const leader1 = new LeaderService('recorder-elect-2', FAST_OPTIONS);
        leader1.setBecameLeaderCallback(becameLeader1);
        leaders.push(leader1);

        const leader2 = new LeaderService('recorder-elect-2', FAST_OPTIONS);
        leader2.setBecameLeaderCallback(becameLeader2);
        leaders.push(leader2);

        leader1.start();
        await sleepMs(300);
        leader2.start();
        await sleepMs(300);

        assert.strictEqual(becameLeader1.mock.callCount(), 1);
        assert.strictEqual(becameLeader2.mock.callCount(), 0);

        // Stop leader1 — leader2 should take over
        await leader1.stop();
        await sleepMs(500);

        assert.strictEqual(becameLeader2.mock.callCount(), 1, 'Second runner should have become recorder');
    });

    it('stop callback is called during shutdown (recorder cleanup)', async () => {
        setup();
        const becameLeader = mock.fn();
        const lostLeader = mock.fn();

        const leader = new LeaderService('recorder-elect-3', FAST_OPTIONS);
        leader.setBecameLeaderCallback(becameLeader);
        leader.setLostLeaderCallback(lostLeader);
        leaders.push(leader);

        leader.start();
        await sleepMs(300);

        assert.strictEqual(becameLeader.mock.callCount(), 1);

        // stop() does NOT call lostLeaderCallback (by design — runner calls recorder.stop() explicitly)
        await leader.stop();
        assert.strictEqual(lostLeader.mock.callCount(), 0);
    });
});
