import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';

import type { MeshClientRegistryBackend, RegisteredClient } from '../../../src';

import { ClientMessage, ServerMessage } from '../../../resources/proto/generated/test/test';
import { MeshSrpcServer, ClientNotFoundError, destroyClientRedis, TestingHelpers, disconnectAllRedis, sleepMs, SrpcClient } from '../../../src';
import { createLogger } from '../../../src/services/logger';

type TestMeta = { userId?: string };

function createDeferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class DelayedRegisterBackend<TMeta> implements MeshClientRegistryBackend<TMeta> {
    private clients = new Map<string, RegisteredClient<TMeta>>();
    private registerStarted = createDeferred<void>();
    private releaseRegister = createDeferred<void>();

    async register(clientId: string, nodeId: number, metadata: TMeta): Promise<number | null> {
        this.registerStarted.resolve();
        await this.releaseRegister.promise;
        const existing = this.clients.get(clientId);
        const supersededNodeId = existing && existing.nodeId !== nodeId ? existing.nodeId : null;
        this.clients.set(clientId, { clientId, nodeId, connectedAt: Date.now(), metadata });
        return supersededNodeId;
    }

    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId) {
            return false;
        }
        this.clients.delete(clientId);
        return true;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.nodeId !== nodeId) {
            return false;
        }
        existing.metadata = metadata;
        return true;
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        return this.clients.get(clientId);
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        return Array.from(this.clients.values());
    }

    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        return Array.from(this.clients.values()).filter(client => client.nodeId === nodeId);
    }

    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const removed = Array.from(this.clients.values()).filter(client => client.nodeId === nodeId);
        for (const client of removed) {
            this.clients.delete(client.clientId);
        }
        return removed;
    }

    waitForRegisterToStart(): Promise<void> {
        return this.registerStarted.promise;
    }

    continueRegister(): void {
        this.releaseRegister.resolve();
    }
}

describe('MeshSrpcServer', () => {
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379,
            SRPC_AUTH_SECRET: 'test-secret'
        }
    });

    before(() => tf.start());
    after(async () => {
        await tf.stop();
        destroyClientRedis();
        await disconnectAllRedis();
    });

    let servers: MeshSrpcServer<TestMeta, ClientMessage, ServerMessage>[] = [];
    let clients: SrpcClient<ClientMessage, ServerMessage>[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        // Disconnect clients first
        for (const client of clients) {
            client.disconnect();
        }
        clients = [];

        // Stop mesh and close servers
        for (const server of servers) {
            try {
                await server.meshStop();
            } catch {
                // ignore
            }
            server.close();
        }
        servers = [];
    });

    const FAST_MESH = {
        heartbeatIntervalMs: 200,
        nodeTtlMs: 600,
        requestTimeoutMs: 2000,
        leaderOptions: {
            ttlMs: 500,
            renewalIntervalMs: 150,
            retryDelayMs: 50
        }
    };

    function createServer(key: string): MeshSrpcServer<TestMeta, ClientMessage, ServerMessage> {
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            extractMetadata: stream => ({ userId: stream.meta.userId })
        });
        servers.push(server);
        return server;
    }

    function createClient(wsPath: string, clientId: string): SrpcClient<ClientMessage, ServerMessage> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const httpServer = (tf as any).httpServer;
        const addr = httpServer.address();
        const port = typeof addr === 'object' ? addr?.port : 3000;

        const client = new SrpcClient<ClientMessage, ServerMessage>(
            createLogger('SrpcTestClient'),
            `ws://127.0.0.1:${port}${wsPath}`,
            ClientMessage,
            ServerMessage,
            clientId,
            { userId: `user-${clientId}` },
            'test-secret',
            { enableReconnect: false, protocolVersion: 1 }
        );
        clients.push(client);
        return client;
    }

    async function waitForConnection(client: SrpcClient<ClientMessage, ServerMessage>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
            client.registerConnectionHandler(() => {
                clearTimeout(timeout);
                resolve();
            });
            client.connect();
        });
    }

    it('auto-registers clients on connect and fires onClientConnected', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const connected: { clientId: string; metadata: TestMeta }[] = [];
        server.onClientConnected((clientId, metadata) => {
            connected.push({ clientId, metadata });
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-1');
        await waitForConnection(client);
        await sleepMs(200);

        assert.strictEqual(connected.length, 1);
        assert.strictEqual(connected[0].clientId, 'client-1');
        assert.deepStrictEqual(connected[0].metadata, { userId: 'user-client-1' });

        // Verify client is in registry
        const regClient = await server.clientRegistry.getClient('client-1');
        assert.ok(regClient);
        assert.strictEqual(regClient.nodeId, server.meshInstanceId);
    });

    it('auto-unregisters client on disconnect and fires onClientDisconnected', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const disconnected: { clientId: string; metadata: TestMeta }[] = [];
        server.onClientDisconnected((clientId, metadata) => {
            disconnected.push({ clientId, metadata });
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-dc');
        await waitForConnection(client);
        await sleepMs(200);

        client.disconnect();
        await sleepMs(200);

        assert.strictEqual(disconnected.length, 1);
        assert.strictEqual(disconnected[0].clientId, 'client-dc');

        // Verify client removed from registry
        const regClient = await server.clientRegistry.getClient('client-dc');
        assert.strictEqual(regClient, undefined);
    });

    it('onClientDisconnected NOT fired when client reconnected to another node', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        const disconnected1: string[] = [];
        server1.onClientDisconnected(clientId => {
            disconnected1.push(clientId);
        });

        // Connect to server1
        const client1 = createClient(`/mesh-srpc-test-${key}`, 'client-reco');
        await waitForConnection(client1);
        await sleepMs(200);

        // Simulate reconnect to server2 by registering the same clientId there
        // This mimics what would happen if the client connected to a different pod
        await server2.clientRegistry.register('client-reco', { userId: 'user-reco' });

        // Now disconnect from server1
        client1.disconnect();
        await sleepMs(200);

        // onClientDisconnected should NOT fire on server1 because the unregister returned false
        assert.strictEqual(disconnected1.length, 0);
    });

    it('invoke routes to local client', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);

        server.registerMessageHandler('uEcho', async (_stream, data) => {
            return { message: `Echo: ${data.message}` };
        });

        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-inv');
        client.registerMessageHandler('dNotify', async _data => {
            return { acknowledged: true };
        });
        await waitForConnection(client);
        await sleepMs(200);

        // Server invokes client via clientId
        const result = await server.invoke('client-inv', 'dNotify', { notification: 'hello' });
        assert.deepStrictEqual(result, { acknowledged: true });
    });

    it('throws ClientNotFoundError for unknown client', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        await assert.rejects(server.invoke('nonexistent', 'dNotify', { notification: 'hello' }), ClientNotFoundError);
    });

    it('throws ClientDisconnectedError when stream is missing locally', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        // Manually register a client in the registry without a stream
        await server.clientRegistry.register('ghost-client', { userId: 'ghost' });

        await assert.rejects(
            server.invoke('ghost-client', 'dNotify', { notification: 'hello' }),
            // The error propagates through the mesh as ClientDisconnectedError
            // or directly when local
            /disconnected/i
        );
    });

    it('meshStart and meshStop lifecycle', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);

        assert.strictEqual(server.meshInstanceId, 0);

        await server.meshStart();
        assert.ok(server.meshInstanceId > 0);

        await server.meshStop();
        assert.strictEqual(server.meshInstanceId, 0);
    });

    it('meshStart backfills clients that connected before tracking started', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);

        // Connect a client BEFORE meshStart
        const client = createClient(`/mesh-srpc-test-${key}`, 'client-early');
        await waitForConnection(client);
        await sleepMs(200);

        // Client should NOT be in registry yet (mesh not started)
        // Now start mesh tracking
        await server.meshStart();

        // Client should now be backfilled into the registry
        const regClient = await server.clientRegistry.getClient('client-early');
        assert.ok(regClient, 'early client should be in registry after meshStart');
        assert.strictEqual(regClient.nodeId, server.meshInstanceId);
        assert.deepStrictEqual(regClient.metadata, { userId: 'user-client-early' });
    });

    it('meshStart backfill does not leave stale entry if client disconnects during startup', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);

        // Connect a client BEFORE meshStart
        const client = createClient(`/mesh-srpc-test-${key}`, 'client-race');
        await waitForConnection(client);
        await sleepMs(200);

        // Disconnect the client right before meshStart — the disconnect handler
        // enqueues an unregister into the lifecycle chain. meshStart's backfill
        // must be serialized with that unregister so it doesn't recreate a stale entry.
        client.disconnect();

        // Give the disconnect handler time to fire and enqueue
        await sleepMs(50);

        await server.meshStart();
        await sleepMs(200);

        // Client should NOT be in the registry — the disconnect should win
        const regClient = await server.clientRegistry.getClient('client-race');
        assert.strictEqual(regClient, undefined, 'stale client should not be in registry after disconnect during meshStart');
    });

    it('meshStart backfill does not recreate client if disconnect happens while register is in flight', async () => {
        const key = `srpc-${++keyCounter}`;
        const registryBackend = new DelayedRegisterBackend<TestMeta>();
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            registryBackend,
            extractMetadata: stream => ({ userId: stream.meta.userId })
        });
        servers.push(server);

        const clientId = 'client-race-inflight';
        const client = createClient(`/mesh-srpc-test-${key}`, clientId);
        await waitForConnection(client);
        await sleepMs(200);

        const disconnectedPromise = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Disconnect callback timeout')), 5000);
            server.onClientDisconnected(disconnectedClientId => {
                if (disconnectedClientId === clientId) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        const meshStartPromise = server.meshStart();
        await registryBackend.waitForRegisterToStart();

        client.disconnect();
        await sleepMs(50);

        registryBackend.continueRegister();
        await meshStartPromise;
        await disconnectedPromise;

        const regClient = await server.clientRegistry.getClient(clientId);
        assert.strictEqual(regClient, undefined, 'client should be removed after disconnect queued behind in-flight backfill register');
    });

    it('same-node reconnect does not fire spurious disconnect callback', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const disconnected: string[] = [];
        const connected: string[] = [];
        server.onClientConnected(clientId => {
            connected.push(clientId);
        });
        server.onClientDisconnected(clientId => {
            disconnected.push(clientId);
        });

        // Connect first client
        const client1 = createClient(`/mesh-srpc-test-${key}`, 'client-recon');
        await waitForConnection(client1);
        await sleepMs(200);

        assert.strictEqual(connected.length, 1);

        // Connect second client with same clientId — triggers duplicate kick of client1
        const client2 = createClient(`/mesh-srpc-test-${key}`, 'client-recon');
        await waitForConnection(client2);
        await sleepMs(200);

        // Should have 2 connected events but NO disconnect events
        assert.strictEqual(connected.length, 2);
        assert.strictEqual(disconnected.length, 0, 'disconnect should not fire on same-node reconnect');

        // Client should still be in registry
        const regClient = await server.clientRegistry.getClient('client-recon');
        assert.ok(regClient, 'client should still be registered after reconnect');

        // Now disconnect the replacement — THIS should fire disconnect
        client2.disconnect();
        await sleepMs(200);

        assert.strictEqual(disconnected.length, 1);
        assert.strictEqual(disconnected[0], 'client-recon');

        // Verify metadata was preserved for the real disconnect callback
        const regClientAfter = await server.clientRegistry.getClient('client-recon');
        assert.strictEqual(regClientAfter, undefined);
    });

    it('works without extractMetadata (uses stream.meta fallback)', async () => {
        const key = `srpc-${++keyCounter}`;

        // Create server WITHOUT extractMetadata
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH
            // No extractMetadata — should fall back to stream.meta
        });
        servers.push(server);
        await server.meshStart();

        const connected: { clientId: string; metadata: TestMeta }[] = [];
        server.onClientConnected((clientId, metadata) => {
            connected.push({ clientId, metadata });
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-nometa');
        await waitForConnection(client);
        await sleepMs(200);

        assert.strictEqual(connected.length, 1);
        // stream.meta should have userId from the client constructor
        assert.strictEqual(connected[0].metadata.userId, 'user-client-nometa');

        // Verify in registry too
        const regClient = await server.clientRegistry.getClient('client-nometa');
        assert.ok(regClient);
    });

    it('onClientConnected callback error is caught without crashing', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const afterError: string[] = [];
        server.onClientConnected(() => {
            throw new Error('callback boom');
        });
        server.onClientConnected(clientId => {
            afterError.push(clientId);
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-cberr');
        await waitForConnection(client);
        await sleepMs(200);

        // Second callback should still have fired despite first throwing
        assert.strictEqual(afterError.length, 1);
        assert.strictEqual(afterError[0], 'client-cberr');
    });

    it('onClientDisconnected callback error is caught without crashing', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const afterError: string[] = [];
        server.onClientDisconnected(() => {
            throw new Error('disconnect callback boom');
        });
        server.onClientDisconnected(clientId => {
            afterError.push(clientId);
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-dcerr');
        await waitForConnection(client);
        await sleepMs(200);

        client.disconnect();
        await sleepMs(200);

        // Second callback should still have fired
        assert.strictEqual(afterError.length, 1);
        assert.strictEqual(afterError[0], 'client-dcerr');
    });

    it('onNodeClientsOrphaned fires end-to-end on node death', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();
        await sleepMs(100);

        const orphanedEvents: { nodeId: number; clients: { clientId: string }[] }[] = [];
        server.onNodeClientsOrphaned((nodeId, clients) => {
            orphanedEvents.push({ nodeId, clients: clients.map(c => ({ clientId: c.clientId })) });
        });

        // Manually register a client as if it were on a different (now-dead) node
        // Use a fake nodeId that we'll simulate crashing
        const fakeNodeId = server.meshInstanceId + 100;
        await server.clientRegistry.register('client-orphan', { userId: 'orphan-user' });

        // Re-register on the fake node directly via the backend
        const meshInternal = (server as any).meshClientService;
        await meshInternal.backend.register('client-orphan', fakeNodeId, { userId: 'orphan-user' });

        // Register the fake node in the mesh sorted set so it can be cleaned up

        const { client: redisClient, prefix } = await import('../../../src/helpers/redis/redis').then(m => {
            return m.createRedis('MESH');
        });
        await redisClient.zadd(`${prefix}:mesh:_mc:${key}:heartbeats`, Date.now().toString(), fakeNodeId.toString());
        await redisClient.hset(`${prefix}:mesh:_mc:${key}:nodes`, fakeNodeId.toString(), JSON.stringify({ hostname: 'fake' }));

        // Wait for the fake node's heartbeat to expire and leader to clean it up
        await sleepMs(1500);

        assert.ok(orphanedEvents.length > 0, 'orphaned callback should have fired');
        const event = orphanedEvents.find(e => e.nodeId === fakeNodeId);
        assert.ok(event, 'should find cleanup event for fake node');
        assert.ok(
            event.clients.some(c => c.clientId === 'client-orphan'),
            'orphaned client should be in list'
        );

        await redisClient.quit();
    });

    it('invoke with SrpcStream delegates to SrpcServer.invoke', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);

        server.registerMessageHandler('uEcho', async (_stream, data) => {
            return { message: `Echo: ${data.message}` };
        });

        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-stream-inv');
        await waitForConnection(client);
        await sleepMs(200);

        // Invoke via client (upstream) to verify SrpcServer.invoke path works
        const result = await client.invoke('uEcho', { message: 'hello' });
        assert.deepStrictEqual(result, { message: 'Echo: hello' });
    });

    it('updateClientMetadata updates registry and local cache', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-meta');
        await waitForConnection(client);
        await sleepMs(200);

        // Verify initial metadata
        let regClient = await server.clientRegistry.getClient('client-meta');
        assert.ok(regClient);
        assert.deepStrictEqual(regClient.metadata, { userId: 'user-client-meta' });

        // Update metadata
        const updated = await server.updateClientMetadata('client-meta', { userId: 'updated-user' });
        assert.strictEqual(updated, true);

        // Verify registry was updated
        regClient = await server.clientRegistry.getClient('client-meta');
        assert.ok(regClient);
        assert.deepStrictEqual(regClient.metadata, { userId: 'updated-user' });

        // Verify local cache was updated — disconnect callback should receive updated metadata
        const disconnected: { clientId: string; metadata: TestMeta }[] = [];
        server.onClientDisconnected((clientId, metadata) => {
            disconnected.push({ clientId, metadata });
        });

        client.disconnect();
        await sleepMs(200);

        assert.strictEqual(disconnected.length, 1);
        assert.deepStrictEqual(disconnected[0].metadata, { userId: 'updated-user' });
    });

    it('updateClientMetadata returns false for non-existent client', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const updated = await server.updateClientMetadata('nonexistent', { userId: 'nope' });
        assert.strictEqual(updated, false);
    });

    it('broadcast and registerBroadcastHandler work across nodes', async () => {
        const key = `srpc-${++keyCounter}`;

        // Need to type the server with broadcasts
        type TestBroadcasts = {
            testEvent: { value: number };
        };

        const server1 = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta, TestBroadcasts>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            extractMetadata: stream => ({ userId: stream.meta.userId })
        });
        servers.push(server1 as unknown as MeshSrpcServer<TestMeta, ClientMessage, ServerMessage>);

        const server2 = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta, TestBroadcasts>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            extractMetadata: stream => ({ userId: stream.meta.userId })
        });
        servers.push(server2 as unknown as MeshSrpcServer<TestMeta, ClientMessage, ServerMessage>);

        const received: { value: number; sender: number }[] = [];
        server2.registerBroadcastHandler('testEvent', (data, senderInstanceId) => {
            received.push({ value: data.value, sender: senderInstanceId });
        });

        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(200);

        await server1.broadcast('testEvent', { value: 42 });
        await sleepMs(200);

        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].value, 42);
        assert.strictEqual(received[0].sender, server1.meshInstanceId);
    });

    it('meta proxy auto-syncs stream.meta mutations to registry', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        // Register a connection handler that mutates stream.meta
        server.registerConnectionHandler(stream => {
            stream.meta.userId = 'mutated-in-handler';
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-proxy');
        await waitForConnection(client);
        // Wait for microtask sync to flush
        await sleepMs(200);

        const regClient = await server.clientRegistry.getClient('client-proxy');
        assert.ok(regClient);
        assert.strictEqual(regClient.metadata.userId, 'mutated-in-handler');
    });

    it('meta proxy batches multiple synchronous mutations into one sync', async () => {
        const key = `srpc-${++keyCounter}`;

        // Track updateMetadata calls via a wrapping backend
        let updateCount = 0;
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            extractMetadata: stream => ({ userId: stream.meta.userId })
        });
        servers.push(server);

        await server.meshStart();

        // Patch updateClientMetadata to count calls

        const meshSvc = (server as any).meshClientService;
        const origSvcUpdate = meshSvc.updateClientMetadata.bind(meshSvc);
        meshSvc.updateClientMetadata = async (...args: any[]) => {
            updateCount++;
            return origSvcUpdate(...args);
        };

        // Mutate meta multiple times synchronously in a connection handler
        server.registerConnectionHandler(stream => {
            stream.meta.userId = 'first';
            stream.meta.userId = 'second';
            stream.meta.userId = 'third';
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-batch');
        await waitForConnection(client);
        await sleepMs(200);

        // Should have been batched: 1 update (not 3)
        // Note: there may also be the initial registration, so we check updateCount specifically
        assert.ok(updateCount <= 1, `expected at most 1 updateMetadata call, got ${updateCount}`);

        // Final value should be 'third'
        const regClient = await server.clientRegistry.getClient('client-batch');
        assert.ok(regClient);
        assert.strictEqual(regClient.metadata.userId, 'third');
    });

    it('meta proxy works without extractMetadata (default path)', async () => {
        const key = `srpc-${++keyCounter}`;

        // No extractMetadata — uses stream.meta directly
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH
        });
        servers.push(server);
        await server.meshStart();

        server.registerConnectionHandler(stream => {
            stream.meta.userId = 'updated-default-path';
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-defmeta');
        await waitForConnection(client);
        await sleepMs(200);

        const regClient = await server.clientRegistry.getClient('client-defmeta');
        assert.ok(regClient);
        assert.strictEqual((regClient.metadata as TestMeta).userId, 'updated-default-path');
    });

    it('meta proxy does not double-proxy on meshStart backfill', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);

        // Connect client BEFORE meshStart
        const client = createClient(`/mesh-srpc-test-${key}`, 'client-nodouble');
        await waitForConnection(client);
        await sleepMs(200);

        // Now start mesh — this backfills and calls installMetaProxy again
        await server.meshStart();

        // Mutate meta after meshStart — should trigger exactly one sync
        let updateCount = 0;
        const meshSvc = (server as any).meshClientService;
        const origUpdate = meshSvc.updateClientMetadata.bind(meshSvc);
        meshSvc.updateClientMetadata = async (...args: any[]) => {
            updateCount++;
            return origUpdate(...args);
        };

        // Access the stream to mutate its meta
        const stream = server.streamsByClientId.get('client-nodouble');
        assert.ok(stream);
        stream.meta.userId = 'post-backfill-update';
        await sleepMs(200);

        // Should be exactly 1 update, not 2 (which would happen with double proxy)
        assert.strictEqual(updateCount, 1, `expected 1 updateMetadata call, got ${updateCount}`);

        const regClient = await server.clientRegistry.getClient('client-nodouble');
        assert.ok(regClient);
        assert.strictEqual(regClient.metadata.userId, 'post-backfill-update');
    });

    it('cross-node client supersession disconnects local stream', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        // Track client disconnections from SRPC level
        let srpcDisconnected = false;
        const client1 = createClient(`/mesh-srpc-test-${key}`, 'client-supersede');
        client1.registerDisconnectHandler(() => {
            srpcDisconnected = true;
        });
        await waitForConnection(client1);
        await sleepMs(200);

        // Verify client is on server1
        let regClient = await server1.clientRegistry.getClient('client-supersede');
        assert.ok(regClient);
        assert.strictEqual(regClient.nodeId, server1.meshInstanceId);

        // Simulate the same client connecting to server2 by registering directly.
        // This triggers the cross-node supersession kick via the mesh.
        const meshSvc2 = (server2 as any).meshClientService;
        await meshSvc2.registerClient('client-supersede', { userId: 'user-supersede' });
        await sleepMs(500);

        // Client should now be on server2
        regClient = await server2.clientRegistry.getClient('client-supersede');
        assert.ok(regClient);
        assert.strictEqual(regClient.nodeId, server2.meshInstanceId);

        // The original client's WebSocket should have been kicked
        assert.strictEqual(srpcDisconnected, true, 'original client should have been disconnected');
    });

    it('meshStop cleans up registered clients', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-cleanup');
        await waitForConnection(client);
        await sleepMs(200);

        // Verify client is registered
        let regClient = await server.clientRegistry.getClient('client-cleanup');
        assert.ok(regClient);

        // meshStop should clean up
        await server.meshStop();

        // Need a new service to check since this one is stopped
        const server2 = createServer(key);
        await server2.meshStart();

        regClient = await server2.clientRegistry.getClient('client-cleanup');
        assert.strictEqual(regClient, undefined);
    });
});
