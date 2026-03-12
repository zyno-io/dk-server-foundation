import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';

import {
    MeshClientService,
    ClientNotFoundError,
    ClientDisconnectedError,
    ClientInvocationError,
    destroyClientRedis,
    TestingHelpers,
    disconnectAllRedis,
    sleepMs
} from '../../../src';

interface TestMeta {
    userId: string;
}

const FAST_OPTIONS = {
    heartbeatIntervalMs: 200,
    nodeTtlMs: 600,
    requestTimeoutMs: 2000,
    leaderOptions: {
        ttlMs: 500,
        renewalIntervalMs: 150,
        retryDelayMs: 50
    }
};

describe('MeshClientService', () => {
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379
        }
    });
    before(() => tf.start());
    after(async () => {
        await tf.stop();
        destroyClientRedis();
        await disconnectAllRedis();
    });

    let services: MeshClientService<TestMeta>[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        await Promise.all(services.map(s => s.stop()));
        services = [];
    });

    function createClientService(
        key: string,
        localClients: Map<string, (type: string, data: unknown) => Promise<unknown>>
    ): MeshClientService<TestMeta> {
        const svc = new MeshClientService<TestMeta>({
            key,
            meshOptions: FAST_OPTIONS,
            clientInvokeFn: async (clientId, type, data, _timeoutMs) => {
                const handler = localClients.get(clientId);
                if (!handler) {
                    throw new ClientDisconnectedError(clientId);
                }
                return handler(type, data);
            }
        });
        services.push(svc);
        return svc;
    }

    it('local delivery invokes clientInvokeFn directly', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const localClients = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc = createClientService(key, localClients);
        await svc.start();

        localClients.set('client-1', async (_type, data) => {
            return { echoed: data };
        });
        await svc.registerClient('client-1', { userId: 'u1' });

        const result = await svc.invoke('client-1', 'echo', { msg: 'hello' });
        assert.deepStrictEqual(result, { echoed: { msg: 'hello' } });
    });

    it('remote delivery routes through mesh', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const localClients1 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc1 = createClientService(key, localClients1);

        const localClients2 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc2 = createClientService(key, localClients2);

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        // Register client on svc1
        localClients1.set('client-1', async (_type, data) => {
            return { handled: data };
        });
        await svc1.registerClient('client-1', { userId: 'u1' });

        // Invoke from svc2 — should route through mesh to svc1
        const result = await svc2.invoke('client-1', 'echo', { msg: 'remote' });
        assert.deepStrictEqual(result, { handled: { msg: 'remote' } });
    });

    it('throws ClientNotFoundError for unknown client', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc = createClientService(key, new Map());
        await svc.start();

        await assert.rejects(svc.invoke('nonexistent', 'echo', {}), ClientNotFoundError);
    });

    it('propagates ClientDisconnectedError from remote node', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const localClients1 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc1 = createClientService(key, localClients1);

        const localClients2 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc2 = createClientService(key, localClients2);

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        // Register client on svc1 but don't add a local handler — simulates disconnected
        await svc1.registerClient('client-1', { userId: 'u1' });

        // Invoke from svc2 — svc1's clientInvokeFn will throw ClientDisconnectedError
        await assert.rejects(svc2.invoke('client-1', 'echo', {}), ClientDisconnectedError);
    });

    it('propagates generic errors as ClientInvocationError', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const localClients1 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc1 = createClientService(key, localClients1);

        const localClients2 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc2 = createClientService(key, localClients2);

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        localClients1.set('client-1', async () => {
            throw new Error('handler exploded');
        });
        await svc1.registerClient('client-1', { userId: 'u1' });

        await assert.rejects(svc2.invoke('client-1', 'echo', {}), ClientInvocationError);
    });

    it('unregisterClient returns ownership result', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc1 = createClientService(key, new Map());
        const svc2 = createClientService(key, new Map());

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        await svc1.registerClient('client-1', { userId: 'u1' });

        // Client reconnects to svc2
        await svc2.registerClient('client-1', { userId: 'u1' });

        // svc1 tries to unregister — should return false
        const removed = await svc1.unregisterClient('client-1');
        assert.strictEqual(removed, false);

        // svc2 unregisters — should return true
        const removed2 = await svc2.unregisterClient('client-1');
        assert.strictEqual(removed2, true);
    });

    it('stop cleans up own clients', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc = createClientService(key, new Map());
        await svc.start();

        await svc.registerClient('client-1', { userId: 'u1' });
        await svc.registerClient('client-2', { userId: 'u2' });

        let clients = await svc.clientRegistry.listClients();
        assert.strictEqual(clients.length, 2);

        await svc.stop();
        // Need another service to check since this one is stopped
        services = services.filter(s => s !== svc);

        const svc2 = createClientService(key, new Map());
        await svc2.start();

        clients = await svc2.clientRegistry.listClients();
        assert.strictEqual(clients.length, 0);
    });

    it('registerClient is a no-op when not running', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc = createClientService(key, new Map());

        // Not started — registerClient should silently return
        await svc.registerClient('client-1', { userId: 'u1' });

        // Start and verify client was NOT registered
        await svc.start();
        const client = await svc.clientRegistry.getClient('client-1');
        assert.strictEqual(client, undefined);
    });

    it('unregisterClient returns false when not running', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc = createClientService(key, new Map());

        const result = await svc.unregisterClient('client-1');
        assert.strictEqual(result, false);
    });

    it('invoke throws ClientNotFoundError when not running', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc = createClientService(key, new Map());

        await assert.rejects(svc.invoke('client-1', 'echo', {}), ClientNotFoundError);
    });

    it('invoke throws ClientNotFoundError after stop', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const localClients = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc = createClientService(key, localClients);
        await svc.start();

        localClients.set('client-1', async (_type, data) => ({ echoed: data }));
        await svc.registerClient('client-1', { userId: 'u1' });

        await svc.stop();
        services = services.filter(s => s !== svc);

        await assert.rejects(svc.invoke('client-1', 'echo', {}), ClientNotFoundError);
    });

    it('stop when never started does not throw', async () => {
        const key = `test-mcs-${++keyCounter}`;
        const svc = createClientService(key, new Map());

        // Should not throw
        await svc.stop();
        services = services.filter(s => s !== svc);
    });

    it('onNodeClientsOrphaned callback error is caught without crashing', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const svc1 = createClientService(key, new Map());
        const svc2 = createClientService(key, new Map());

        let callbackCalled = false;
        svc1.onNodeClientsOrphaned(() => {
            callbackCalled = true;
            throw new Error('callback boom');
        });

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        await svc2.registerClient('client-1', { userId: 'u1' });

        // Wait for leader election
        await sleepMs(300);

        // Simulate crash of svc2
        const svc2Internal = svc2 as any;
        svc2Internal.mesh.running = false;
        if (svc2Internal.mesh.heartbeatTimer) {
            clearInterval(svc2Internal.mesh.heartbeatTimer);
            svc2Internal.mesh.heartbeatTimer = null;
        }
        if (svc2Internal.mesh.leaderService) {
            await svc2Internal.mesh.leaderService.stop();
            svc2Internal.mesh.leaderService = null;
        }

        // Wait for TTL to expire + cleanup cycle
        await sleepMs(1200);

        assert.ok(callbackCalled, 'callback should have been called');
        // svc1 should still be running despite the callback error
        assert.strictEqual((svc1 as any).running, true);

        // Clean up svc2's subscriber manually
        if (svc2Internal.mesh.subscriberClient) {
            try {
                await svc2Internal.mesh.subscriberClient.unsubscribe();
                await svc2Internal.mesh.subscriberClient.quit();
            } catch {
                /* ignore */
            }
            svc2Internal.mesh.subscriberClient = null;
        }
        services = services.filter(s => s !== svc2);
    });

    it('cleanup with zero orphaned clients does not fire callbacks', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const svc1 = createClientService(key, new Map());
        const svc2 = createClientService(key, new Map());

        let callbackCalled = false;
        svc1.onNodeClientsOrphaned(() => {
            callbackCalled = true;
        });

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        // No clients registered on svc2

        // Wait for leader election
        await sleepMs(300);

        // Simulate crash of svc2
        const svc2Internal = svc2 as any;
        svc2Internal.mesh.running = false;
        if (svc2Internal.mesh.heartbeatTimer) {
            clearInterval(svc2Internal.mesh.heartbeatTimer);
            svc2Internal.mesh.heartbeatTimer = null;
        }
        if (svc2Internal.mesh.leaderService) {
            await svc2Internal.mesh.leaderService.stop();
            svc2Internal.mesh.leaderService = null;
        }

        // Wait for TTL to expire + cleanup cycle
        await sleepMs(1200);

        // Callback should NOT have been called since no clients were orphaned
        assert.strictEqual(callbackCalled, false);

        // Clean up svc2's subscriber manually
        if (svc2Internal.mesh.subscriberClient) {
            try {
                await svc2Internal.mesh.subscriberClient.unsubscribe();
                await svc2Internal.mesh.subscriberClient.quit();
            } catch {
                /* ignore */
            }
            svc2Internal.mesh.subscriberClient = null;
        }
        services = services.filter(s => s !== svc2);
    });

    it('forward handler handles non-Error throw with String fallback', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const localClients1 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc1 = createClientService(key, localClients1);

        const localClients2 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc2 = createClientService(key, localClients2);

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        localClients1.set('client-1', async () => {
            // eslint-disable-next-line no-throw-literal
            throw 'string error';
        });
        await svc1.registerClient('client-1', { userId: 'u1' });

        // Invoke from svc2 — should get ClientInvocationError with the string
        await assert.rejects(svc2.invoke('client-1', 'echo', {}), (err: Error) => {
            assert.ok(err instanceof ClientInvocationError);
            assert.ok(err.message.includes('string error'));
            return true;
        });
    });

    it('node death triggers cleanup of orphaned clients', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const svc1 = createClientService(key, new Map());
        const svc2 = createClientService(key, new Map());

        await svc1.start();
        await svc2.start();
        await sleepMs(100);

        await svc2.registerClient('client-1', { userId: 'u1' });
        await svc2.registerClient('client-2', { userId: 'u2' });

        // Wait for leader election
        await sleepMs(300);

        // Simulate crash of svc2
        const svc2Internal = svc2 as any;
        svc2Internal.mesh.running = false;
        if (svc2Internal.mesh.heartbeatTimer) {
            clearInterval(svc2Internal.mesh.heartbeatTimer);
            svc2Internal.mesh.heartbeatTimer = null;
        }
        if (svc2Internal.mesh.leaderService) {
            await svc2Internal.mesh.leaderService.stop();
            svc2Internal.mesh.leaderService = null;
        }

        // Wait for TTL to expire + cleanup cycle
        await sleepMs(1200);

        // After cleanup, orphaned clients should be gone
        const clients = await svc1.clientRegistry.listClients();
        assert.strictEqual(clients.length, 0);

        // Clean up svc2's subscriber manually
        if (svc2Internal.mesh.subscriberClient) {
            try {
                await svc2Internal.mesh.subscriberClient.unsubscribe();
                await svc2Internal.mesh.subscriberClient.quit();
            } catch {
                /* ignore */
            }
            svc2Internal.mesh.subscriberClient = null;
        }
        services = services.filter(s => s !== svc2);
    });

    it('handles concurrent cross-node invocations to the same client', async () => {
        const key = `test-mcs-${++keyCounter}`;

        const localClients1 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc1 = createClientService(key, localClients1);

        const localClients2 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc2 = createClientService(key, localClients2);

        const localClients3 = new Map<string, (type: string, data: unknown) => Promise<unknown>>();
        const svc3 = createClientService(key, localClients3);

        await svc1.start();
        await svc2.start();
        await svc3.start();
        await sleepMs(100);

        let callCount = 0;
        localClients1.set('target', async (_type, data) => {
            callCount++;
            await sleepMs(50); // simulate some work
            return { echoed: data, call: callCount };
        });
        await svc1.registerClient('target', { userId: 'target-user' });

        // Both svc2 and svc3 invoke the same client on svc1 concurrently
        const [r1, r2, r3, r4] = await Promise.all([
            svc2.invoke('target', 'echo', { from: 'svc2-a' }),
            svc3.invoke('target', 'echo', { from: 'svc3-a' }),
            svc2.invoke('target', 'echo', { from: 'svc2-b' }),
            svc3.invoke('target', 'echo', { from: 'svc3-b' })
        ]);

        // All should have received responses
        assert.deepStrictEqual((r1 as any).echoed, { from: 'svc2-a' });
        assert.deepStrictEqual((r2 as any).echoed, { from: 'svc3-a' });
        assert.deepStrictEqual((r3 as any).echoed, { from: 'svc2-b' });
        assert.deepStrictEqual((r4 as any).echoed, { from: 'svc3-b' });

        // Handler should have been called 4 times
        assert.strictEqual(callCount, 4);
    });
});
