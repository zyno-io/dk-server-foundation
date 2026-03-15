import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it, before, after, afterEach } from 'node:test';
import WebSocket from 'ws';

import type { MeshClientRegistryBackend, RegisteredClient, RegisterResult } from '../../../src';

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
    private clients = new Map<string, { client: RegisteredClient<TMeta>; state: 'active' | 'pending' }>();
    private registerStarted = createDeferred<void>();
    private releaseRegister = createDeferred<void>();

    private async registerWithState(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        state: 'active' | 'pending'
    ): Promise<RegisterResult> {
        this.registerStarted.resolve();
        await this.releaseRegister.promise;
        const existing = this.clients.get(clientId);
        if (existing && existing.client.nodeId !== nodeId && !allowSupersede) {
            return { status: 'conflict', ownerNodeId: existing.client.nodeId };
        }
        const supersededNodeId = existing && existing.client.nodeId !== nodeId ? existing.client.nodeId : null;
        this.clients.set(clientId, { client: { clientId, nodeId, connectedAt: Date.now(), metadata }, state });
        return { status: 'ok', supersededNodeId };
    }

    async register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        return this.registerWithState(clientId, nodeId, metadata, allowSupersede, 'active');
    }

    async reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        return this.registerWithState(clientId, nodeId, metadata, allowSupersede, 'pending');
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.client.nodeId !== nodeId) {
            return false;
        }
        existing.client.metadata = metadata;
        existing.state = 'active';
        return true;
    }

    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.client.nodeId !== nodeId) {
            return false;
        }
        this.clients.delete(clientId);
        return true;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const existing = this.clients.get(clientId);
        if (!existing || existing.client.nodeId !== nodeId) {
            return false;
        }
        existing.client.metadata = metadata;
        return true;
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        const existing = this.clients.get(clientId);
        return existing?.state === 'active' ? existing.client : undefined;
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        return Array.from(this.clients.values())
            .filter(client => client.state === 'active')
            .map(client => client.client);
    }

    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        return Array.from(this.clients.values())
            .filter(client => client.state === 'active' && client.client.nodeId === nodeId)
            .map(client => client.client);
    }

    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const removed = Array.from(this.clients.values())
            .filter(client => client.client.nodeId === nodeId)
            .map(client => client.client);
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

    seedClient(clientId: string, nodeId: number, metadata: TMeta): void {
        this.clients.set(clientId, { client: { clientId, nodeId, connectedAt: Date.now(), metadata }, state: 'active' });
    }
}

class ImmediateRegisterBackend<TMeta> extends DelayedRegisterBackend<TMeta> {
    constructor() {
        super();
        this.continueRegister();
    }
}

class ThrowingRegisterBackend<TMeta> extends DelayedRegisterBackend<TMeta> {
    override async register(_clientId: string, _nodeId: number, _metadata: TMeta, _allowSupersede = true): Promise<RegisterResult> {
        throw new Error('register boom');
    }

    override async reserve(_clientId: string, _nodeId: number, _metadata: TMeta, _allowSupersede = true): Promise<RegisterResult> {
        throw new Error('register boom');
    }
}

describe('MeshSrpcServer', () => {
    const TEST_AUTH_SECRET = 'test-secret';
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379,
            SRPC_AUTH_SECRET: TEST_AUTH_SECRET
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

    function createServer(
        key: string,
        options?: { registryBackend?: MeshClientRegistryBackend<TestMeta> }
    ): MeshSrpcServer<TestMeta, ClientMessage, ServerMessage> {
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            registryBackend: options?.registryBackend,
            extractMetadata: stream => ({ userId: stream.meta.userId })
        });
        servers.push(server);
        return server;
    }

    function createClient(
        wsPath: string,
        clientId: string,
        options?: { protocolVersion?: number; enableReconnect?: boolean }
    ): SrpcClient<ClientMessage, ServerMessage> {
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
            TEST_AUTH_SECRET,
            { enableReconnect: options?.enableReconnect ?? false, protocolVersion: options?.protocolVersion ?? 1 }
        );
        clients.push(client);
        return client;
    }

    function createRawWsUrl(wsPath: string, clientId: string, options?: { protocolVersion?: number; supersede?: boolean }): string {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const httpServer = (tf as any).httpServer;
        const addr = httpServer.address();
        const port = typeof addr === 'object' ? addr?.port : 3000;
        const protocolVersion = options?.protocolVersion ?? 2;
        const authv = 1;
        const appv = '0.0.0';
        const ts = Date.now();
        const streamId = `raw-${clientId}-${ts}`;
        const signature = createHmac('sha256', TEST_AUTH_SECRET).update(`${authv}\n${appv}\n${ts}\n${streamId}\n${clientId}\n`).digest('hex');

        const url = new URL(`ws://127.0.0.1:${port}${wsPath}`);
        url.searchParams.set('authv', String(authv));
        url.searchParams.set('appv', appv);
        url.searchParams.set('ts', String(ts));
        url.searchParams.set('id', streamId);
        url.searchParams.set('cid', clientId);
        url.searchParams.set('signature', signature);
        url.searchParams.set('_v', String(protocolVersion));
        url.searchParams.set('m--userId', `user-${clientId}`);
        if (options?.supersede) {
            url.searchParams.set('_supersede', '1');
        }

        return url.toString();
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

    it('rejects connect promptly when mesh registration throws', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key, { registryBackend: new ThrowingRegisterBackend<TestMeta>() });
        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-register-throw');
        const result = await Promise.race([
            client.connect().then(
                () => 'resolved' as const,
                err => err
            ),
            sleepMs(2000).then(() => 'timeout' as const)
        ]);

        assert.notStrictEqual(result, 'timeout');
        assert.notStrictEqual(result, 'resolved');
        assert.match((result as Error).message, /Connection failed: disconnect/);
        assert.strictEqual(client.isConnected, false);
    });

    it('async connection handlers can invoke after the initial ping without delaying connect()', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const handlerInvokedClient = createDeferred<void>();

        server.registerConnectionHandler(async stream => {
            handlerStarted.resolve();
            await releaseHandler.promise;

            try {
                const result = await server.invoke(stream, 'dNotify', { notification: 'hello from async handler' });
                assert.deepStrictEqual(result, { acknowledged: true });
                handlerInvokedClient.resolve();
            } catch (err) {
                handlerInvokedClient.reject(err);
            }
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-handler-order', { protocolVersion: 2 });
        client.registerMessageHandler('dNotify', async data => {
            assert.strictEqual(data.notification, 'hello from async handler');
            return { acknowledged: true };
        });

        const connectPromise = client.connect();

        await handlerStarted.promise;
        const connectState = await Promise.race([connectPromise.then(() => 'resolved' as const), sleepMs(100).then(() => 'pending' as const)]);
        assert.strictEqual(connectState, 'resolved');

        releaseHandler.resolve();
        await connectPromise;

        await handlerInvokedClient.promise;
        assert.strictEqual(client.isConnected, true);
    });

    it('disconnects the stream when a connection handler rejects after the handshake', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const disconnected = createDeferred<void>();
        server.registerConnectionHandler(async () => {
            throw new Error('connect boom');
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-connect-throw', { protocolVersion: 2 });
        client.registerDisconnectHandler(() => {
            disconnected.resolve();
        });

        await client.connect();
        await Promise.race([disconnected.promise, sleepMs(2000).then(() => Promise.reject(new Error('disconnect timeout')))]);

        assert.strictEqual(client.isConnected, false);
    });

    it('does not process client RPCs until async connection handlers succeed', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const disconnected = createDeferred<void>();
        const requestHandled = createDeferred<void>();
        let handledRequests = 0;

        server.registerConnectionHandler(async () => {
            handlerStarted.resolve();
            await releaseHandler.promise;
            throw new Error('connect boom');
        });
        server.registerMessageHandler('uEcho', async (_stream, data) => {
            handledRequests += 1;
            requestHandled.resolve();
            return { message: data.message };
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-activation-gate', { protocolVersion: 2 });
        client.registerDisconnectHandler(() => {
            disconnected.resolve();
        });

        const connectPromise = client.connect();
        await handlerStarted.promise;
        await connectPromise;

        const invokePromise = client.invoke('uEcho', { message: 'should-not-run' }, 500).then(
            () => 'resolved' as const,
            err => err
        );
        const handledState = await Promise.race([requestHandled.promise.then(() => 'handled' as const), sleepMs(100).then(() => 'pending' as const)]);

        assert.strictEqual(handledState, 'pending');

        releaseHandler.resolve();
        await Promise.race([disconnected.promise, sleepMs(2000).then(() => Promise.reject(new Error('disconnect timeout')))]);

        const invokeResult = await invokePromise;
        assert.notStrictEqual(invokeResult, 'resolved');
        assert.strictEqual(handledRequests, 0);
    });

    it('buffers client RPCs sent immediately after connect until activation completes', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const requestHandled = createDeferred<void>();

        server.registerConnectionHandler(async () => {
            handlerStarted.resolve();
            await releaseHandler.promise;
        });

        server.registerMessageHandler('uEcho', async (_stream, data) => {
            requestHandled.resolve();
            return { message: data.message };
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-buffer-after-connect', { protocolVersion: 2 });
        const connectPromise = client.connect();

        await handlerStarted.promise;
        await connectPromise;

        const invokePromise = client.invoke('uEcho', { message: 'after-connect' }, 2000);
        const handledState = await Promise.race([requestHandled.promise.then(() => 'handled' as const), sleepMs(100).then(() => 'pending' as const)]);

        assert.strictEqual(handledState, 'pending');

        releaseHandler.resolve();

        const result = await invokePromise;
        assert.deepStrictEqual(result, { message: 'after-connect' });
    });

    it('preserves client RPC ordering until activation callbacks finish', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const connectedCallbackStarted = createDeferred<void>();
        const releaseConnectedCallback = createDeferred<void>();
        const handledMessages: string[] = [];

        server.registerConnectionHandler(async stream => {
            if (stream.clientId !== 'client-buffer-order') return;
            handlerStarted.resolve();
            await releaseHandler.promise;
        });
        server.onClientConnected(async clientId => {
            if (clientId !== 'client-buffer-order') return;
            connectedCallbackStarted.resolve();
            await releaseConnectedCallback.promise;
        });
        server.registerMessageHandler('uEcho', async (_stream, data) => {
            handledMessages.push(data.message);
            return { message: data.message };
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-buffer-order', { protocolVersion: 2 });
        const connectPromise = client.connect();

        await handlerStarted.promise;
        await connectPromise;

        const firstInvokePromise = client.invoke('uEcho', { message: 'first' }, 2000);

        releaseHandler.resolve();
        await connectedCallbackStarted.promise;

        const secondInvokePromise = client.invoke('uEcho', { message: 'second' }, 2000);
        await sleepMs(100);

        assert.deepStrictEqual(handledMessages, []);

        releaseConnectedCallback.resolve();

        const [firstResult, secondResult] = await Promise.all([firstInvokePromise, secondInvokePromise]);
        assert.deepStrictEqual(firstResult, { message: 'first' });
        assert.deepStrictEqual(secondResult, { message: 'second' });
        assert.deepStrictEqual(handledMessages, ['first', 'second']);
    });

    it('does not expose a client through the mesh before async activation completes', async () => {
        const key = `srpc-${++keyCounter}`;
        const registryBackend = new ImmediateRegisterBackend<TestMeta>();
        const server1 = createServer(key, { registryBackend });
        const server2 = createServer(key, { registryBackend });
        await server1.meshStart();
        await server2.meshStart();

        const clientId = 'client-async-activation-visibility';
        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const activated = createDeferred<void>();

        server1.registerConnectionHandler(async stream => {
            if (stream.clientId !== clientId) return;
            handlerStarted.resolve();
            await releaseHandler.promise;
        });
        server1.onClientConnected(connectedClientId => {
            if (connectedClientId === clientId) {
                activated.resolve();
            }
        });

        const client = createClient(`/mesh-srpc-test-${key}`, clientId, { protocolVersion: 2 });
        client.registerMessageHandler('dNotify', async data => {
            return { acknowledged: data.notification === 'after-activation' };
        });

        const connectPromise = client.connect();
        await handlerStarted.promise;
        await connectPromise;

        try {
            await assert.rejects(server2.invoke(clientId, 'dNotify', { notification: 'too-early' }, 200), ClientNotFoundError);
        } finally {
            releaseHandler.resolve();
            await activated.promise;
        }

        const result = await server2.invoke(clientId, 'dNotify', { notification: 'after-activation' });
        assert.deepStrictEqual(result, { acknowledged: true });
    });

    it('onClientConnected can invoke the client immediately after the initial ping', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const connectedInvoke = new Promise<void>((resolve, reject) => {
            server.onClientConnected(clientId => {
                server.invoke(clientId, 'dNotify', { notification: 'hello from connect' }).then(result => {
                    assert.deepStrictEqual(result, { acknowledged: true });
                    resolve();
                }, reject);
            });
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-connect-invoke');
        client.registerMessageHandler('dNotify', async data => {
            assert.strictEqual(data.notification, 'hello from connect');
            return { acknowledged: true };
        });

        await client.connect();
        await connectedInvoke;

        assert.strictEqual(client.isConnected, true);
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

    it('does not fire onClientDisconnected for a stream that never activated', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const disconnected: string[] = [];

        server.registerConnectionHandler(async stream => {
            if (stream.clientId !== 'client-never-activated') return;
            handlerStarted.resolve();
            await releaseHandler.promise;
        });
        server.onClientDisconnected(clientId => {
            disconnected.push(clientId);
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-never-activated', { protocolVersion: 2 });
        const connectPromise = client.connect();

        await handlerStarted.promise;
        await connectPromise;

        client.disconnect();
        await sleepMs(200);
        releaseHandler.resolve();
        await sleepMs(100);

        assert.deepStrictEqual(disconnected, []);
        const regClient = await server.clientRegistry.getClient('client-never-activated');
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

    it('meshStart backfills clients that are still pending activation when tracking starts', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        const clientId = 'client-early-pending';
        const handlerStarted = createDeferred<void>();
        const releaseHandler = createDeferred<void>();
        const activated = createDeferred<void>();

        server.registerConnectionHandler(async stream => {
            if (stream.clientId !== clientId) return;
            handlerStarted.resolve();
            await releaseHandler.promise;
        });
        server.onClientConnected(connectedClientId => {
            if (connectedClientId === clientId) {
                activated.resolve();
            }
        });

        const client = createClient(`/mesh-srpc-test-${key}`, clientId, { protocolVersion: 2 });
        const connectPromise = client.connect();

        await handlerStarted.promise;
        await connectPromise;

        await server.meshStart();

        releaseHandler.resolve();
        await activated.promise;

        const regClient = await server.clientRegistry.getClient(clientId);
        assert.ok(regClient, 'pending pre-meshStart client should be in registry after activation completes');
        assert.strictEqual(regClient.nodeId, server.meshInstanceId);
        assert.deepStrictEqual(regClient.metadata, { userId: `user-${clientId}` });
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

    it('does not process pipelined client requests before postEstablishCheck accepts the stream', async () => {
        const key = `srpc-${++keyCounter}`;
        const registryBackend = new DelayedRegisterBackend<TestMeta>();
        const server = createServer(key, { registryBackend });
        await server.meshStart();

        registryBackend.seedClient('client-early-request', server.meshInstanceId + 1, { userId: 'other-node' });

        let handledRequests = 0;
        server.registerMessageHandler('uEcho', async (_stream, data) => {
            handledRequests += 1;
            return { message: data.message };
        });

        const ws = new WebSocket(createRawWsUrl(`/mesh-srpc-test-${key}`, 'client-early-request', { protocolVersion: 2 }));
        const closeEvent = new Promise<{ code: number; reason: string }>(resolve => {
            ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
        });

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        await registryBackend.waitForRegisterToStart();
        ws.send(
            ClientMessage.encode({
                requestId: 'early-1',
                reply: false,
                uEchoRequest: { message: 'should-not-run' }
            }).finish()
        );

        registryBackend.continueRegister();
        const close = await closeEvent;

        assert.strictEqual(close.code, 4001);
        assert.match(close.reason, /conflict/);
        assert.strictEqual(handledRequests, 0);
    });

    it('does not publish a reconnecting stream for local invoke delivery before activation succeeds', async () => {
        const key = `srpc-${++keyCounter}`;
        const registryBackend = new DelayedRegisterBackend<TestMeta>();
        const server = createServer(key, { registryBackend });
        await server.meshStart();

        const clientId = 'client-reconnect-pending';
        registryBackend.seedClient(clientId, server.meshInstanceId, { userId: `user-${clientId}` });

        const ws = new WebSocket(createRawWsUrl(`/mesh-srpc-test-${key}`, clientId, { protocolVersion: 2, supersede: true }));
        const firstFramePromise = new Promise<ReturnType<typeof ServerMessage.decode>>((resolve, reject) => {
            ws.once('message', data => resolve(ServerMessage.decode(data as Uint8Array)));
            ws.once('error', reject);
        });

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        await registryBackend.waitForRegisterToStart();

        const invokeResultPromise = server.invoke(clientId, 'dNotify', { notification: 'too-early' }, 200).then(
            () => 'resolved' as const,
            err => err
        );
        const earlyFrame = await Promise.race([firstFramePromise, sleepMs(100).then(() => null)]);

        assert.strictEqual(earlyFrame, null);

        registryBackend.continueRegister();

        const firstFrame = await firstFramePromise;
        assert.deepStrictEqual(firstFrame.pingPong, {});

        const invokeResult = await invokeResultPromise;
        assert.notStrictEqual(invokeResult, 'resolved');
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

    it('same-client reconnect does not wait for prior onClientConnected callbacks', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const firstConnectedStarted = createDeferred<void>();
        const releaseFirstConnected = createDeferred<void>();
        let blockFirstConnected = true;

        server.onClientConnected(async clientId => {
            if (clientId !== 'client-recon-pending' || !blockFirstConnected) {
                return;
            }
            blockFirstConnected = false;
            firstConnectedStarted.resolve();
            await releaseFirstConnected.promise;
        });

        const client1 = createClient(`/mesh-srpc-test-${key}`, 'client-recon-pending', { protocolVersion: 2 });
        await client1.connect();
        await firstConnectedStarted.promise;

        const client2 = createClient(`/mesh-srpc-test-${key}`, 'client-recon-pending', { protocolVersion: 2 });
        const connectPromise = client2.connect({ supersede: true });
        const connectState = await Promise.race([connectPromise.then(() => 'resolved' as const), sleepMs(100).then(() => 'pending' as const)]);

        assert.strictEqual(connectState, 'resolved');

        releaseFirstConnected.resolve();
        await connectPromise;
        assert.strictEqual(client2.isConnected, true);
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

    it('fires lifecycle callbacks for falsy metadata values', async () => {
        const falsyMetadata = [0, '', false, undefined] as const;

        for (const [index, metadata] of falsyMetadata.entries()) {
            const key = `srpc-${++keyCounter}`;
            const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, typeof metadata>({
                logger: createLogger('MeshSrpcTest'),
                clientMessage: ClientMessage,
                serverMessage: ServerMessage,
                wsPath: `/mesh-srpc-test-${key}`,
                logLevel: false,
                meshKey: key,
                meshOptions: FAST_MESH,
                extractMetadata: () => metadata
            });
            servers.push(server as unknown as MeshSrpcServer<TestMeta, ClientMessage, ServerMessage>);
            await server.meshStart();

            const connected: unknown[] = [];
            const disconnected: unknown[] = [];
            server.onClientConnected((_clientId, receivedMetadata) => {
                connected.push(receivedMetadata);
            });
            server.onClientDisconnected((_clientId, receivedMetadata) => {
                disconnected.push(receivedMetadata);
            });

            const client = createClient(`/mesh-srpc-test-${key}`, `client-falsy-${index}`, { protocolVersion: 2 });
            await waitForConnection(client);
            await sleepMs(150);

            client.disconnect();
            await sleepMs(200);

            assert.deepStrictEqual(connected, [metadata]);
            assert.deepStrictEqual(disconnected, [metadata]);
        }
    });

    it('preserves array metadata shapes when snapshotting for lifecycle and registry state', async () => {
        const key = `srpc-${++keyCounter}`;
        const metadata = ['alpha', 'beta'];
        const registryBackend = new ImmediateRegisterBackend<readonly string[]>();
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, readonly string[]>({
            logger: createLogger('MeshSrpcTest'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/mesh-srpc-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
            registryBackend,
            extractMetadata: () => metadata
        });
        servers.push(server as unknown as MeshSrpcServer<TestMeta, ClientMessage, ServerMessage>);
        await server.meshStart();

        const connected: ReadonlyArray<string>[] = [];
        const disconnected: ReadonlyArray<string>[] = [];
        server.onClientConnected((_clientId, receivedMetadata) => {
            connected.push(receivedMetadata);
        });
        server.onClientDisconnected((_clientId, receivedMetadata) => {
            disconnected.push(receivedMetadata);
        });

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-array-meta', { protocolVersion: 2 });
        await waitForConnection(client);
        await sleepMs(150);

        const regClient = await server.clientRegistry.getClient('client-array-meta');
        assert.deepStrictEqual(regClient?.metadata, metadata);

        client.disconnect();
        await sleepMs(200);

        assert.deepStrictEqual(connected, [metadata]);
        assert.deepStrictEqual(disconnected, [metadata]);
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

    it('updateClientMetadata restores clientMetadata on failure', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-rollback');
        await waitForConnection(client);
        await sleepMs(200);

        // Verify initial metadata is cached
        const clientMetadata = (server as any).clientMetadata as Map<string, TestMeta>;
        const initial = clientMetadata.get('client-rollback');
        assert.ok(initial);
        assert.deepStrictEqual(initial, { userId: 'user-client-rollback' });

        // Make registry.updateMetadata fail by stubbing it
        const registry = server.clientRegistry;
        const origUpdate = registry.updateMetadata.bind(registry);
        registry.updateMetadata = async () => false;

        const updated = await server.updateClientMetadata('client-rollback', { userId: 'should-rollback' });
        assert.strictEqual(updated, false);

        // clientMetadata should be restored to the original value
        const restored = clientMetadata.get('client-rollback');
        assert.deepStrictEqual(restored, { userId: 'user-client-rollback' });

        // Restore stub so cleanup works
        registry.updateMetadata = origUpdate;
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
        const registry = server.clientRegistry;
        const origUpdate = registry.updateMetadata.bind(registry);
        registry.updateMetadata = async (clientId: string, metadata: any) => {
            updateCount++;
            return origUpdate(clientId, metadata);
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

    it('cross-node updateClientMetadata routes through mesh and updates owning stream.meta', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        // Connect client to server1
        const client = createClient(`/mesh-srpc-test-${key}`, 'client-xmeta');
        await waitForConnection(client);
        await sleepMs(200);

        // Verify initial metadata on server1
        const stream = server1.streamsByClientId.get('client-xmeta');
        assert.ok(stream);
        assert.strictEqual(stream.meta.userId, 'user-client-xmeta');

        // Update metadata from server2 (non-owning node)
        const updated = await server2.updateClientMetadata('client-xmeta', { userId: 'cross-pod-update' });
        assert.strictEqual(updated, true);

        // Allow the proxy sync microtask to fire and update Redis
        await sleepMs(200);

        // Verify stream.meta on owning pod (server1) was updated
        assert.strictEqual(stream.meta.userId, 'cross-pod-update');

        // Verify registry reflects the update
        const regClient = await server1.clientRegistry.getClient('client-xmeta');
        assert.ok(regClient);
        assert.deepStrictEqual(regClient.metadata, { userId: 'cross-pod-update' });
    });

    it('cross-node updateClientMetadata returns false for non-existent client', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        const updated = await server2.updateClientMetadata('nonexistent', { userId: 'nope' });
        assert.strictEqual(updated, false);
    });

    it('cross-node updateClientMetadata updates disconnect callback metadata', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-xdiscon');
        await waitForConnection(client);
        await sleepMs(200);

        // Update metadata from non-owning node
        await server2.updateClientMetadata('client-xdiscon', { userId: 'updated-from-remote' });
        await sleepMs(200);

        // Register disconnect handler on owning server
        const disconnected: { clientId: string; metadata: TestMeta }[] = [];
        server1.onClientDisconnected((clientId, metadata) => {
            disconnected.push({ clientId, metadata });
        });

        client.disconnect();
        await sleepMs(200);

        assert.strictEqual(disconnected.length, 1);
        assert.deepStrictEqual(disconnected[0].metadata, { userId: 'updated-from-remote' });
    });

    it('local updateClientMetadata updates stream.meta immediately', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-localmeta');
        await waitForConnection(client);
        await sleepMs(200);

        const stream = server.streamsByClientId.get('client-localmeta');
        assert.ok(stream);
        assert.strictEqual(stream.meta.userId, 'user-client-localmeta');

        // Update metadata locally — should update stream.meta AND registry
        const updated = await server.updateClientMetadata('client-localmeta', { userId: 'local-update' });
        assert.strictEqual(updated, true);

        // stream.meta should reflect immediately (no microtask wait needed)
        assert.strictEqual(stream.meta.userId, 'local-update');

        // Registry should also be updated (direct write, not proxy path)
        const regClient = await server.clientRegistry.getClient('client-localmeta');
        assert.ok(regClient);
        assert.deepStrictEqual(regClient.metadata, { userId: 'local-update' });
    });

    it('local updateClientMetadata does not cause redundant registry write', async () => {
        const key = `srpc-${++keyCounter}`;
        const server = createServer(key);
        await server.meshStart();

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-nodup');
        await waitForConnection(client);
        await sleepMs(200);

        // Spy on registry.updateMetadata to count calls
        let updateCount = 0;
        const registry = server.clientRegistry;
        const origUpdate = registry.updateMetadata.bind(registry);
        registry.updateMetadata = async (clientId: string, metadata: any) => {
            updateCount++;
            return origUpdate(clientId, metadata);
        };

        // Update metadata — should trigger exactly 1 registry write (direct),
        // NOT 2 (proxy sync should see shallowChanged=false and skip)
        await server.updateClientMetadata('client-nodup', { userId: 'no-dup-write' });
        await sleepMs(200); // Wait for any proxy microtask to settle

        assert.strictEqual(updateCount, 1, `expected 1 registry write, got ${updateCount}`);
    });

    it('cross-node updateClientMetadata returns false when stream disconnects before handler', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-xdiscon2');
        await waitForConnection(client);
        await sleepMs(200);

        // Verify client is on server1
        const regClient = await server1.clientRegistry.getClient('client-xdiscon2');
        assert.ok(regClient);
        assert.strictEqual(regClient.nodeId, server1.meshInstanceId);

        // Disconnect the client before updating
        client.disconnect();
        await sleepMs(200);

        // Cross-node update should return false since stream is gone
        const updated = await server2.updateClientMetadata('client-xdiscon2', { userId: 'too-late' });
        assert.strictEqual(updated, false);
    });

    it('updateClientMetadata returns false for pending-state client', async () => {
        const key = `srpc-${++keyCounter}`;
        const backend = new ImmediateRegisterBackend<TestMeta>();
        const server = createServer(key, { registryBackend: backend });
        await server.meshStart();

        // Seed a pending-state client directly in the backend
        // (ImmediateRegisterBackend inherits seedClient which sets state='active',
        // so we use the reserve method to get a pending client)
        const meshSvc = (server as any).meshClientService;
        await meshSvc.reserveClient('client-pending', { userId: 'pending-user' });

        // getClient filters out pending clients, so updateClientMetadata should return false
        const regClient = await server.clientRegistry.getClient('client-pending');
        assert.strictEqual(regClient, undefined, 'pending client should not be discoverable via getClient');

        const updated = await server.updateClientMetadata('client-pending', { userId: 'nope' });
        assert.strictEqual(updated, false);
    });

    it('concurrent stream.meta mutation and cross-node updateClientMetadata', async () => {
        const key = `srpc-${++keyCounter}`;
        const server1 = createServer(key);
        const server2 = createServer(key);
        await server1.meshStart();
        await server2.meshStart();
        await sleepMs(100);

        const client = createClient(`/mesh-srpc-test-${key}`, 'client-race');
        await waitForConnection(client);
        await sleepMs(200);

        const stream = server1.streamsByClientId.get('client-race');
        assert.ok(stream);

        // Fire a local mutation and a cross-pod update concurrently.
        // Both write to stream.meta; the last write wins.
        stream.meta.userId = 'local-mutation';
        const updatePromise = server2.updateClientMetadata('client-race', { userId: 'remote-update' });

        await updatePromise;
        await sleepMs(200); // Let proxy microtasks settle

        // The remote update arrives via mesh invoke which is async,
        // so it executes after the synchronous local mutation.
        // Final state should be the remote update.
        assert.strictEqual(stream.meta.userId, 'remote-update');

        // Registry should be consistent with stream.meta
        const regClient = await server1.clientRegistry.getClient('client-race');
        assert.ok(regClient);
        assert.strictEqual(regClient.metadata.userId, 'remote-update');
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
