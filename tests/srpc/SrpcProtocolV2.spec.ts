import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';

import type { SrpcDisconnectCause } from '../../src';

import { ClientMessage, ServerMessage } from '../../resources/proto/generated/test/test';
import { MeshSrpcServer, destroyClientRedis, TestingHelpers, disconnectAllRedis, sleepMs, SrpcClient, SrpcConflictError } from '../../src';
import { createLogger } from '../../src/services/logger';

type TestMeta = { userId?: string };

describe('SRPC Protocol V2', () => {
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

    afterEach(async () => {
        for (const client of clients) {
            client.disconnect();
        }
        clients = [];

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

    function createServer(key: string): MeshSrpcServer<TestMeta, ClientMessage, ServerMessage> {
        const server = new MeshSrpcServer<TestMeta, ClientMessage, ServerMessage, TestMeta>({
            logger: createLogger('SrpcV2Test'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: `/srpc-v2-test-${key}`,
            logLevel: false,
            meshKey: key,
            meshOptions: FAST_MESH,
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
            createLogger('SrpcV2TestClient'),
            `ws://127.0.0.1:${port}${wsPath}`,
            ClientMessage,
            ServerMessage,
            clientId,
            { userId: `user-${clientId}` },
            'test-secret',
            {
                enableReconnect: options?.enableReconnect ?? false,
                protocolVersion: options?.protocolVersion
            }
        );
        clients.push(client);
        return client;
    }

    describe('v1 protocol (default server behavior)', () => {
        it('new connection supersedes existing connection automatically', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const client1 = createClient(wsPath, 'shared-id', { protocolVersion: 1 });
            await client1.connect();

            const client2 = createClient(wsPath, 'shared-id', { protocolVersion: 1 });
            await client2.connect();
            await sleepMs(100);

            // client2 should be connected, client1 should have been kicked
            assert.strictEqual(client2.isConnected, true);
            assert.strictEqual(client1.isConnected, false);
        });
    });

    describe('v2 protocol', () => {
        it('rejects new connection on client ID collision', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            // First client connects successfully
            const client1 = createClient(wsPath, 'shared-id');
            await client1.connect();
            assert.strictEqual(client1.isConnected, true);

            // Second client with same ID should be rejected
            const client2 = createClient(wsPath, 'shared-id');
            await assert.rejects(
                () => client2.connect(),
                err => err instanceof SrpcConflictError
            );

            // First client should still be connected
            assert.strictEqual(client1.isConnected, true);
            assert.strictEqual(client2.isConnected, false);
        });

        it('allows connection with supersede flag', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const client1 = createClient(wsPath, 'shared-id');
            await client1.connect();
            assert.strictEqual(client1.isConnected, true);

            // Connect with supersede — should kick client1
            const client2 = createClient(wsPath, 'shared-id');
            await client2.connect({ supersede: true });
            await sleepMs(100);

            assert.strictEqual(client2.isConnected, true);
            assert.strictEqual(client1.isConnected, false);
        });

        it('connect resolves on successful handshake', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const client = createClient(wsPath, 'solo-client');
            await client.connect();

            assert.strictEqual(client.isConnected, true);
        });

        it('connect promise can be used fire-and-forget without unhandled rejections', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const client1 = createClient(wsPath, 'shared-id');
            await client1.connect();

            // Fire-and-forget connect that will be rejected — should NOT cause
            // unhandled rejection warnings
            const client2 = createClient(wsPath, 'shared-id');
            client2.connect();
            await sleepMs(500);

            assert.strictEqual(client1.isConnected, true);
        });

        it('does not auto-reconnect on conflict rejection', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const client1 = createClient(wsPath, 'shared-id');
            await client1.connect();

            // Second client with reconnect enabled
            const client2 = createClient(wsPath, 'shared-id', { enableReconnect: true });
            await assert.rejects(
                () => client2.connect(),
                err => err instanceof SrpcConflictError
            );

            // Wait long enough that a reconnect would have fired
            await sleepMs(2000);

            // client2 should still be disconnected (no reconnect)
            assert.strictEqual(client2.isConnected, false);
            assert.strictEqual(client1.isConnected, true);
        });

        it('allows new connection when no existing client with same ID', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const client1 = createClient(wsPath, 'id-a');
            const client2 = createClient(wsPath, 'id-b');

            await client1.connect();
            await client2.connect();

            assert.strictEqual(client1.isConnected, true);
            assert.strictEqual(client2.isConnected, true);
        });
    });

    describe('disconnect cause', () => {
        it('passes "duplicate" cause when superseded by another connection', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const causes: SrpcDisconnectCause[] = [];
            const client1 = createClient(wsPath, 'shared-id');
            client1.registerDisconnectHandler(cause => {
                causes.push(cause);
            });
            await client1.connect();

            // Supersede with v2 client
            const client2 = createClient(wsPath, 'shared-id');
            await client2.connect({ supersede: true });
            await sleepMs(100);

            assert.strictEqual(causes.length, 1);
            assert.strictEqual(causes[0], 'duplicate');
        });

        it('passes "disconnect" cause on normal disconnection', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const causes: SrpcDisconnectCause[] = [];
            const client = createClient(wsPath, 'solo-client');
            client.registerDisconnectHandler(cause => {
                causes.push(cause);
            });
            await client.connect();

            // Server closes the stream
            const stream = server.streamsByClientId.get('solo-client');
            assert.ok(stream);
            stream.$ws.close(1000);
            await sleepMs(100);

            assert.strictEqual(causes.length, 1);
            assert.strictEqual(causes[0], 'disconnect');
        });

        it('passes "duplicate" cause when superseded by v1 client', async () => {
            const key = `v2-${++keyCounter}`;
            const server = createServer(key);
            await server.meshStart();

            const wsPath = `/srpc-v2-test-${key}`;

            const causes: SrpcDisconnectCause[] = [];
            const client1 = createClient(wsPath, 'shared-id');
            client1.registerDisconnectHandler(cause => {
                causes.push(cause);
            });
            await client1.connect();

            // v1 client auto-supersedes
            const client2 = createClient(wsPath, 'shared-id', { protocolVersion: 1 });
            await client2.connect();
            await sleepMs(100);

            assert.strictEqual(causes.length, 1);
            assert.strictEqual(causes[0], 'duplicate');
        });
    });
});
