import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';

import { disconnectAllRedis, LeaderService, sleepMs, TestingHelpers } from '../../src';

const FAST_OPTIONS = {
    ttlMs: 2000,
    renewalIntervalMs: 500,
    retryDelayMs: 200
};

describe('LeaderService', () => {
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

    let services: LeaderService[];

    beforeEach(() => {
        services = [];
    });

    afterEach(async () => {
        await Promise.all(services.map(s => s.stop()));
    });

    function createService(key: string, options = FAST_OPTIONS): LeaderService {
        const svc = new LeaderService(key, options);
        services.push(svc);
        return svc;
    }

    it('acquires leadership', async () => {
        const becameLeader = mock.fn();
        const svc = createService('LeaderTest1');
        svc.setBecameLeaderCallback(becameLeader);
        svc.start();

        await sleepMs(500);
        assert.strictEqual(becameLeader.mock.callCount(), 1);
    });

    it('throws if started twice', () => {
        const svc = createService('LeaderTest2');
        svc.start();
        assert.throws(() => svc.start(), { message: 'LeaderService is already running' });
    });

    it('only one instance becomes leader for the same key', async () => {
        const becameLeader1 = mock.fn();
        const becameLeader2 = mock.fn();

        const svc1 = createService('LeaderTest3');
        svc1.setBecameLeaderCallback(becameLeader1);
        svc1.start();

        await sleepMs(300);

        const svc2 = createService('LeaderTest3');
        svc2.setBecameLeaderCallback(becameLeader2);
        svc2.start();

        await sleepMs(500);

        assert.strictEqual(becameLeader1.mock.callCount(), 1);
        assert.strictEqual(becameLeader2.mock.callCount(), 0);
    });

    it('second instance becomes leader after first stops', async () => {
        const becameLeader1 = mock.fn();
        const becameLeader2 = mock.fn();

        const svc1 = createService('LeaderTest4');
        svc1.setBecameLeaderCallback(becameLeader1);
        svc1.start();

        await sleepMs(300);

        const svc2 = createService('LeaderTest4');
        svc2.setBecameLeaderCallback(becameLeader2);
        svc2.start();

        await sleepMs(300);
        assert.strictEqual(becameLeader2.mock.callCount(), 0);

        await svc1.stop();
        await sleepMs(500);

        assert.strictEqual(becameLeader2.mock.callCount(), 1);
    });

    it('maintains leadership through renewals', async () => {
        const lostLeader = mock.fn();
        const svc = createService('LeaderTest5');
        svc.setLostLeaderCallback(lostLeader);
        svc.start();

        // Wait longer than the renewal interval but less than TTL
        await sleepMs(1500);

        assert.strictEqual(lostLeader.mock.callCount(), 0);
    });

    it('second instance takes over after TTL expires', async () => {
        const becameLeader2 = mock.fn();

        const svc1 = createService('LeaderTest6', {
            ttlMs: 800,
            renewalIntervalMs: 300,
            retryDelayMs: 200
        });
        svc1.start();
        await sleepMs(300);

        const svc2 = createService('LeaderTest6', {
            ttlMs: 800,
            renewalIntervalMs: 300,
            retryDelayMs: 200
        });
        svc2.setBecameLeaderCallback(becameLeader2);
        svc2.start();

        await sleepMs(200);
        assert.strictEqual(becameLeader2.mock.callCount(), 0);

        // Force stop without releasing the lock (simulate crash)
        // We stop renewals but don't release
        (svc1 as any).running = false;
        if ((svc1 as any).renewTimer) {
            clearInterval((svc1 as any).renewTimer);
            (svc1 as any).renewTimer = null;
        }

        // Wait for TTL to expire + retry
        await sleepMs(1500);

        assert.strictEqual(becameLeader2.mock.callCount(), 1);
    });

    it('calls lostLeader callback when leadership is lost', async () => {
        const lostLeader = mock.fn();

        const svc = createService('LeaderTest7', {
            ttlMs: 600,
            renewalIntervalMs: 200,
            retryDelayMs: 200
        });
        svc.setLostLeaderCallback(lostLeader);
        svc.start();

        await sleepMs(300);

        // Sabotage the lock by changing the lockId so renewal fails
        (svc as any).lockId = 'bogus';

        await sleepMs(500);

        assert.strictEqual(lostLeader.mock.callCount(), 1);
    });

    it('re-acquires leadership after losing it', async () => {
        const becameLeader = mock.fn();
        const lostLeader = mock.fn();

        const svc = createService('LeaderTest8', {
            ttlMs: 600,
            renewalIntervalMs: 200,
            retryDelayMs: 200
        });
        svc.setBecameLeaderCallback(becameLeader);
        svc.setLostLeaderCallback(lostLeader);
        svc.start();

        await sleepMs(300);
        assert.strictEqual(becameLeader.mock.callCount(), 1);

        // Sabotage the lock so renewal fails
        (svc as any).lockId = 'bogus';

        // Wait for lost + TTL expiry + re-acquire
        await sleepMs(1500);

        assert.strictEqual(lostLeader.mock.callCount(), 1);
        assert.strictEqual(becameLeader.mock.callCount(), 2);
    });

    it('different keys have independent leaders', async () => {
        const becameLeaderA = mock.fn();
        const becameLeaderB = mock.fn();

        const svcA = createService('LeaderTest9A');
        svcA.setBecameLeaderCallback(becameLeaderA);
        svcA.start();

        const svcB = createService('LeaderTest9B');
        svcB.setBecameLeaderCallback(becameLeaderB);
        svcB.start();

        await sleepMs(500);

        assert.strictEqual(becameLeaderA.mock.callCount(), 1);
        assert.strictEqual(becameLeaderB.mock.callCount(), 1);
    });

    it('stops retrying acquisition after stop', async () => {
        const becameLeader = mock.fn();

        // First service holds the lock
        const svc1 = createService('LeaderTest10');
        svc1.start();
        await sleepMs(300);

        // Second service can't acquire, will be retrying
        const svc2 = createService('LeaderTest10');
        svc2.setBecameLeaderCallback(becameLeader);
        svc2.start();
        await sleepMs(300);
        assert.strictEqual(becameLeader.mock.callCount(), 0);

        // Stop the second service, then release the first
        await svc2.stop();
        await svc1.stop();

        // Even though the lock is now free, svc2 should not acquire
        await sleepMs(500);
        assert.strictEqual(becameLeader.mock.callCount(), 0);
    });

    it('handles callback errors without crashing', async () => {
        const lostLeader = mock.fn();

        const svc = createService('LeaderTest11', {
            ttlMs: 600,
            renewalIntervalMs: 200,
            retryDelayMs: 200
        });
        svc.setBecameLeaderCallback(() => {
            throw new Error('callback error');
        });
        svc.setLostLeaderCallback(lostLeader);
        svc.start();

        // Should not crash despite callback error
        await sleepMs(500);

        // Service should still be running and holding leadership
        assert.strictEqual(lostLeader.mock.callCount(), 0);
    });
});
