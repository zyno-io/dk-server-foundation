import { ScopedLogger } from '@deepkit/logger';
import { createHmac } from 'crypto';
import { Readable } from 'stream';
import WebSocket from 'ws';

import { ApplicationServer } from '@deepkit/framework';

import { ClientMessage, ServerMessage } from '../resources/proto/generated/test/test';
import { AutoStart, BaseAppConfig } from '../src/app';
import { sleepSecs, uuid7 } from '../src/helpers';
import { SrpcByteStream, SrpcClient, SrpcError, SrpcMeta, SrpcServer, SrpcStream } from '../src/srpc';

const TEST_WS_PATH = '/srpc-test';

type TestClientOutput = ClientMessage;
type TestServerOutput = ServerMessage;

@AutoStart()
export class SrpcTesterService {
    private server: SrpcServer<SrpcMeta, TestClientOutput, TestServerOutput>;
    private connectedStream: SrpcStream | undefined;
    public testsCompleted = false;
    public testsFailed = false;

    constructor(
        private logger: ScopedLogger,
        private appConfig: BaseAppConfig,
        private appServer: ApplicationServer
    ) {
        // Expand clock drift to keep tests stable on slower systems
        this.appConfig.SRPC_AUTH_CLOCK_DRIFT_MS = 60_000;

        // Debug: Log what secrets are available via config (not env)
        this.logger.info('Configuration check:', {
            SRPC_AUTH_SECRET: this.appConfig.SRPC_AUTH_SECRET ? '***set***' : 'NOT SET'
        });

        // Create and configure server
        this.logger.info('Bootstrapping SrpcServer transport', { wsPath: TEST_WS_PATH });
        this.server = new SrpcServer<SrpcMeta, TestClientOutput, TestServerOutput>({
            logger: this.logger.scoped('SrpcServer'),
            clientMessage: ClientMessage,
            serverMessage: ServerMessage,
            wsPath: TEST_WS_PATH,
            debug: false
        });

        // Use custom key fetcher to read from app config
        this.server.setClientKeyFetcher(async clientId => {
            const secret = this.getServerSecret();
            this.logger.info('Server fetching key for client:', { clientId, hasSecret: !!secret });
            return secret || false;
        });

        this.setupServerHandlers();

        // Track connected streams for server-to-client tests
        this.server.registerConnectionHandler(stream => {
            this.connectedStream = stream;
        });

        // Run tests after a short delay to ensure server is ready
        setTimeout(
            () =>
                this.runTests()
                    .then(() => {
                        this.logger.info('SRPC tests completed successfully!');
                        this.testsCompleted = true;
                    })
                    .catch(err => {
                        this.logger.error('SRPC tests failed:', err);
                        this.testsFailed = true;
                        throw err;
                    }),
            1000
        );
    }

    private get httpPort(): number {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this.appServer.getHttpWorker()['server']!.address() as any).port;
    }

    private setupServerHandlers() {
        // Echo handler
        this.server.registerMessageHandler('uEcho', async (_stream, data) => {
            return { message: `Echo: ${data.message}` };
        });

        // Complex data types handler
        this.server.registerMessageHandler('uComplex', async (_stream, data) => {
            const result = `Processed: ${data.stringField}, ${data.intField}, ${data.boolField}`;
            const count = data.arrayField.length + Object.keys(data.mapField).length;
            return { result, count };
        });

        // Error handler
        this.server.registerMessageHandler('uError', async (_stream, data) => {
            throw new SrpcError(data.errorMessage, data.userError);
        });

        // Upload handler (client to server byte stream)
        this.server.registerMessageHandler('uUpload', async (stream, data) => {
            const receiver = SrpcByteStream.createReceiver(stream, data.streamId);
            const chunks: Buffer[] = [];

            for await (const chunk of receiver) {
                chunks.push(chunk);
            }

            const totalBytes = Buffer.concat(chunks).length;
            return { message: `Uploaded ${data.filename}`, bytesReceived: totalBytes };
        });

        // Download handler (server to client byte stream)
        this.server.registerMessageHandler('uDownload', async (stream, data) => {
            const testData = Buffer.from(`Test file contents for ${data.filename}`, 'utf-8');
            const sender = SrpcByteStream.createSender(stream);

            setTimeout(() => {
                sender.write(testData);
                sender.end();
            }, 10);

            return { streamId: sender.id, bytesTotal: testData.length };
        });

        // Slow request handler
        this.server.registerMessageHandler('uSlow', async (_stream, data) => {
            const start = Date.now();
            await new Promise(resolve => setTimeout(resolve, data.delayMs));
            const actualDelay = Date.now() - start;
            return { message: 'Completed', actualDelayMs: actualDelay };
        });
    }

    private createClient(clientId: string, autoConnect = true): Promise<SrpcClient<TestClientOutput, TestServerOutput>> {
        const secret = this.getServerSecret();

        const client = new SrpcClient<TestClientOutput, TestServerOutput>(
            this.logger.scoped('WsClient'),
            `ws://localhost:${this.httpPort}${TEST_WS_PATH}`,
            ClientMessage,
            ServerMessage,
            clientId,
            { testEnv: 'testapp' },
            secret,
            { enableReconnect: false }
        );

        if (!autoConnect) {
            return Promise.resolve(client);
        }

        return new Promise<SrpcClient<TestClientOutput, TestServerOutput>>(resolve => {
            client.registerConnectionHandler(() => resolve(client));
            client.connect();
        });
    }

    private async runTests() {
        this.logger.info('Starting SRPC tests...');

        // Give server time to start
        await sleepSecs(0.5);

        await this.testConnectionAndAuthentication();
        await this.testClientToServerRPC();
        await this.testServerToClientRPC();
        await this.testByteStreams();
        await this.testConnectionLifecycle();
        await this.testCustomMetadata();

        // Run legacy raw WebSocket test for backwards compatibility
        await this.testRawWebsocketClient();

        await this.testUnmatchedUpgradeRejection();

        this.logger.info('All SRPC tests passed!');
    }

    private async testConnectionAndAuthentication() {
        this.logger.info('[Test Start] Connection and Authentication');

        // Test: Valid connection
        this.logger.info('Creating SRPC client with valid credentials');
        const client = await this.createClient(`test-ws-${Date.now()}`);
        if (!client.isConnected) {
            throw new Error('Client should be connected');
        }
        this.logger.info('  ✓ Valid credentials connection');

        // Clean up for next test
        this.logger.info('Disconnecting valid client before invalid auth test');
        client.disconnect();
        await sleepSecs(0.2);

        // Test: Invalid signature
        this.logger.info('Attempting connection with invalid signature to ensure rejection');

        let connectedWithBadSecret = false;
        const badClient = new SrpcClient<TestClientOutput, TestServerOutput>(
            this.logger.scoped('BadWsClient'),
            `ws://localhost:${this.httpPort}${TEST_WS_PATH}`,
            ClientMessage,
            ServerMessage,
            'bad-client',
            {},
            'wrong-secret',
            { enableReconnect: false }
        );

        badClient.registerConnectionHandler(() => {
            connectedWithBadSecret = true;
        });

        badClient.connect();
        await sleepSecs(1);

        if (connectedWithBadSecret) {
            throw new Error('Should not connect with invalid signature');
        }
        this.logger.info('Bad client was rejected as expected');
        this.logger.info('  ✓ Invalid signature rejection');

        badClient.disconnect();
        this.logger.info('[Test End] Connection and Authentication');
    }

    private async testClientToServerRPC() {
        this.logger.info('[Test Start] Client-to-Server RPC');

        const client = await this.createClient(`test-rpc-ws-${Date.now()}`);

        // Test: Simple echo (using simplified invoke syntax)
        this.logger.info('Sending uEchoRequest payload');
        const echoResponse = await client.invoke('uEcho', {
            message: 'Hello, SRPC!'
        });
        if (echoResponse.message !== 'Echo: Hello, SRPC!') {
            throw new Error('Echo response mismatch');
        }
        this.logger.info('Received expected uEchoResponse payload');
        this.logger.info('  ✓ Simple echo request');

        // Test: Complex data types (using simplified invoke syntax)
        this.logger.info('Sending uComplexRequest payload');
        const complexResponse = await client.invoke('uComplex', {
            stringField: 'test',
            intField: 42,
            doubleField: 3.14,
            boolField: true,
            arrayField: ['a', 'b', 'c'],
            mapField: { key1: 'value1', key2: 'value2' }
        });
        if (!complexResponse.result?.includes('test') || complexResponse.count !== 5) {
            throw new Error('Complex data type handling failed');
        }
        this.logger.info('Complex response validated', { response: complexResponse });
        this.logger.info('  ✓ Complex data types');

        // Test: Error propagation
        this.logger.info('Triggering uErrorRequest to confirm error propagation');
        try {
            await client.invoke('uError', {
                errorMessage: 'Test error',
                userError: false
            });
            throw new Error('Should have thrown error');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            if (!errorMsg || !errorMsg.includes('Test error')) {
                throw new Error(`Error message not propagated correctly. Got: ${errorMsg}`);
            }
        }
        this.logger.info('  ✓ Application error propagation');

        // Test: Async request completion
        this.logger.info('Invoking uSlowRequest with 100ms delay');
        const asyncResponse = await client.invoke('uSlow', { delayMs: 100 }, 5000);
        if (asyncResponse.message !== 'Completed') {
            throw new Error(`Async request failed: expected message 'Completed' but got '${asyncResponse.message}'`);
        }
        if (asyncResponse.actualDelayMs < 90) {
            throw new Error(`Async request failed: expected delay >= 90ms but got ${asyncResponse.actualDelayMs}ms`);
        }
        this.logger.info('  ✓ Async request completion');

        // Test: Request timeout
        this.logger.info('Invoking uSlowRequest with 2000ms delay and 500ms timeout');
        try {
            await client.invoke('uSlow', { delayMs: 2000 }, 500);
            throw new Error('Request should have timed out');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            if (!errorMsg.toLowerCase().includes('timeout') && !errorMsg.includes('Request should have timed out')) {
                throw new Error(`Expected timeout error but got: ${errorMsg}`);
            }
            if (errorMsg.includes('Request should have timed out')) {
                throw new Error('Request did not timeout as expected');
            }
        }
        this.logger.info('  ✓ Request timeout');

        // Test: Concurrent requests
        this.logger.info('Scheduling 10 concurrent uEchoRequest invocations');
        const requests = Array.from({ length: 10 }, (_, i) => client.invoke('uEcho', { message: `Message ${i}` }));
        const responses = await Promise.all(requests);
        if (responses.length !== 10) {
            throw new Error('Concurrent requests failed');
        }
        this.logger.info('All concurrent responses received');
        this.logger.info('  ✓ Concurrent requests (10)');

        client.disconnect();
        await sleepSecs(0.2);
        this.logger.info('[Test End] Client-to-Server RPC');
    }

    private async testServerToClientRPC() {
        this.logger.info('[Test Start] Server-to-Client RPC');

        const client = await this.createClient(`test-s2c-ws-${Date.now()}`);

        // Wait for server to register the stream
        this.logger.info('Waiting for server to register inbound stream');
        await sleepSecs(0.2);

        if (!this.connectedStream) {
            throw new Error('Server should have registered connected stream');
        }

        // Test: Server invoking client
        this.logger.info('Registering notify handler on client for server invocation');
        client.registerMessageHandler('dNotify', async data => {
            if (data.notification !== 'Test notification') {
                throw new Error('Notification content mismatch');
            }
            return { acknowledged: true };
        });

        this.logger.info('Invoking server->client notify workflow (using simplified invoke syntax)');
        const notifyResponse = await this.server.invoke(this.connectedStream, 'dNotify', {
            notification: 'Test notification'
        });
        if (!notifyResponse.acknowledged) {
            throw new Error('Server-to-client invocation failed');
        }
        this.logger.info('  ✓ Server invoking client');

        // Test: Client computation (using simplified invoke syntax)
        this.logger.info('Registering compute handler on client');
        client.registerMessageHandler('dCompute', async data => {
            let result = data.number;
            if (data.operation === 'square') result = data.number * data.number;
            if (data.operation === 'double') result = data.number * 2;
            return { result };
        });

        this.logger.info('Invoking compute handler from server');
        const squareResponse = await this.server.invoke(this.connectedStream, 'dCompute', {
            number: 5,
            operation: 'square'
        });
        if (squareResponse.result !== 25) {
            throw new Error('Client computation failed');
        }
        this.logger.info('  ✓ Client computation requests');

        client.disconnect();
        await sleepSecs(0.2);
        this.logger.info('[Test End] Server-to-Client RPC');
    }

    private async testByteStreams() {
        this.logger.info('[Test Start] Byte Streams');

        const client = await this.createClient(`test-bytes-ws-${Date.now()}`);

        // Test: Upload (client to server)
        this.logger.info('Starting client->server byte stream upload');
        const uploadData = Buffer.from('Hello from client byte stream!', 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sender = SrpcByteStream.createSender(client as any);
        const uploadPromise = client.invoke('uUpload', {
            streamId: sender.id,
            filename: 'test.txt'
        });
        this.logger.info('Sending upload payload to server');
        sender.write(uploadData);
        sender.end();
        const uploadResponse = await uploadPromise;
        if (uploadResponse.bytesReceived !== uploadData.length) {
            throw new Error('Upload byte count mismatch');
        }
        this.logger.info('  ✓ Upload via byte stream');

        // Test: Download (server to client)
        this.logger.info('Requesting server->client byte stream download');
        const downloadResponse = await client.invoke('uDownload', {
            filename: 'download.txt'
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const receiver = SrpcByteStream.createReceiver(client as any, downloadResponse.streamId);
        const downloadChunks: Buffer[] = [];
        for await (const chunk of receiver) {
            downloadChunks.push(chunk);
        }

        const receivedData = Buffer.concat(downloadChunks);
        if (receivedData.length !== downloadResponse.bytesTotal) {
            throw new Error('Download byte count mismatch');
        }
        this.logger.info('  ✓ Download via byte stream');

        // Test: Large stream (1MB)
        const largeData = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < largeData.length; i++) {
            largeData[i] = i % 256;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const largeSender = SrpcByteStream.createSender(client as any);
        const largeUploadPromise = client.invoke('uUpload', {
            streamId: largeSender.id,
            filename: 'large.bin'
        });
        this.logger.info('Streaming 1MB payload to server for stress test');
        largeSender.write(largeData);
        largeSender.end();
        const largeResponse = await largeUploadPromise;
        if (largeResponse.bytesReceived !== largeData.length) {
            throw new Error('Large stream byte count mismatch');
        }
        this.logger.info('  ✓ Large byte stream (1MB)');

        // Test: Chunked streaming
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkSender = SrpcByteStream.createSender(client as any);
        const textChunks = ['Hello ', 'from ', 'chunked ', 'stream!'];
        const chunkUploadPromise = client.invoke('uUpload', {
            streamId: chunkSender.id,
            filename: 'chunked.txt'
        });
        this.logger.info('Writing text chunks sequentially');
        for (const chunk of textChunks) {
            chunkSender.write(Buffer.from(chunk, 'utf-8'));
        }
        chunkSender.end();
        const chunkResponse = await chunkUploadPromise;
        if (chunkResponse.bytesReceived !== textChunks.join('').length) {
            throw new Error('Chunked stream byte count mismatch');
        }
        this.logger.info('  ✓ Chunked streaming');

        // Test: Node.js Readable stream
        const readableData = 'Stream from Readable!';
        const readable = Readable.from([Buffer.from(readableData, 'utf-8')]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pipedSender = SrpcByteStream.createSender(client as any);
        const pipedUploadPromise = client.invoke('uUpload', {
            streamId: pipedSender.id,
            filename: 'piped.txt'
        });

        readable.pipe(pipedSender);
        this.logger.info('Piping readable stream into SRPC sender');
        await new Promise((resolve, reject) => {
            pipedSender.on('finish', resolve);
            pipedSender.on('error', reject);
        });

        const pipedResponse = await pipedUploadPromise;
        if (pipedResponse.bytesReceived !== readableData.length) {
            throw new Error('Piped stream byte count mismatch');
        }
        this.logger.info('  ✓ Node.js Readable stream integration');

        client.disconnect();
        await sleepSecs(0.2);
        this.logger.info('[Test End] Byte Streams');
    }

    private async testConnectionLifecycle() {
        this.logger.info('[Test Start] Connection Lifecycle');

        const events: string[] = [];
        const clientId = `test-lifecycle-ws-${Date.now()}`;

        this.server.registerConnectionHandler(stream => {
            events.push(`server-connected:${stream.clientId}`);
        });

        this.server.registerDisconnectHandler((stream, cause) => {
            events.push(`server-disconnected:${stream.clientId}:${cause}`);
        });

        const client = await this.createClient(clientId, false);

        client.registerConnectionHandler(() => {
            events.push('client-connected');
        });

        client.registerDisconnectHandler(() => {
            events.push('client-disconnected');
        });

        client.connect();
        this.logger.info('Connection lifecycle client initiated', { clientId });
        await this.waitForEvent(() => events.includes('client-connected'), 2_000, 'Client connection event not fired');
        await this.waitForEvent(() => events.some(e => e === `server-connected:${clientId}`), 2_000, 'Server connection event not fired');
        this.logger.info('  ✓ Connection handlers');

        client.disconnect();
        await this.waitForEvent(() => events.includes('client-disconnected'), 2_000, 'Client disconnection event not fired');
        await this.waitForEvent(
            () => events.some(e => e.startsWith(`server-disconnected:${clientId}:`)),
            2_000,
            'Server disconnection event not fired'
        );
        this.logger.info('  ✓ Disconnection handlers');
        this.logger.info('[Test End] Connection Lifecycle');
    }

    private async testCustomMetadata() {
        this.logger.info('[Test Start] Custom Metadata');

        const customMeta = { appVersion: '1.2.3', userId: 'test-user' };
        const clientId = `custom-meta-ws-${Date.now()}`;

        const metaPromise = new Promise<SrpcMeta>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout waiting for metadata')), 3000);
            this.server.registerConnectionHandler(stream => {
                if (stream.clientId === clientId) {
                    clearTimeout(timeout);
                    resolve(stream.meta);
                }
            });
        });

        const customClient = new SrpcClient<TestClientOutput, TestServerOutput>(
            this.logger.scoped('CustomMetaWsClient'),
            `ws://localhost:${this.httpPort}${TEST_WS_PATH}`,
            ClientMessage,
            ServerMessage,
            clientId,
            customMeta,
            this.getServerSecret(),
            { enableReconnect: false }
        );

        this.logger.info('Connecting custom metadata client');
        await new Promise<void>(resolve => {
            customClient.registerConnectionHandler(() => resolve());
            customClient.connect();
        });

        this.logger.info('Awaiting metadata capture from server-side connection handler');
        const receivedMeta = await metaPromise;
        const normalizedMeta = Object.fromEntries(Object.entries(receivedMeta).map(([key, value]) => [key.toLowerCase(), value]));
        if (normalizedMeta.appversion !== '1.2.3' || normalizedMeta.userid !== 'test-user') {
            throw new Error(`Custom metadata not passed correctly. Got: ${JSON.stringify(normalizedMeta)}`);
        }
        this.logger.info('  ✓ Custom metadata passing');

        customClient.disconnect();
        await sleepSecs(0.2);
        this.logger.info('[Test End] Custom Metadata');
    }

    private async testRawWebsocketClient() {
        this.logger.info('[Test Start] Raw WebSocket Client (backwards compatibility)');

        const secret = this.getServerSecret();
        const clientId = `ws-raw-${Date.now()}`;
        const streamId = uuid7();
        const authv = 1;
        const appv = '0.0.0';
        const ts = Date.now().toString();

        const signable = `${authv}\n${appv}\n${ts}\n${streamId}\n${clientId}\n`;
        const signature = createHmac('sha256', secret).update(signable).digest('hex');

        const params = new URLSearchParams({
            authv: String(authv),
            appv,
            ts,
            id: streamId,
            cid: clientId,
            signature
        });
        params.set('m--testEnv', 'testapp-ws');

        const requestId = uuid7();
        const requestBuffer = ClientMessage.encode({
            requestId,
            reply: false,
            uEchoRequest: { message: 'Hello via raw WS' }
        }).finish();

        const pongBuffer = ClientMessage.encode({ requestId: '', reply: false, pingPong: {} }).finish();

        await new Promise<void>((resolve, reject) => {
            const wsUrl = `ws://localhost:${this.httpPort}${TEST_WS_PATH}?${params.toString()}`;
            const ws = new WebSocket(wsUrl);

            const finish = (err?: Error) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if ((ws as any)._finished) return;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (ws as any)._finished = true;
                clearTimeout(timeout);
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };

            ws.once('error', err => {
                finish(err instanceof Error ? err : new Error(String(err)));
            });

            ws.on('close', code => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (!(ws as any)._finished) {
                    finish(new Error(`WebSocket closed prematurely (code: ${code})`));
                }
            });

            let requestSent = false;

            ws.on('message', data => {
                if (!(data instanceof Buffer)) return;
                const message = ServerMessage.decode(data);

                if (message.pingPong) {
                    ws.send(pongBuffer);
                    if (!requestSent) {
                        ws.send(requestBuffer);
                        requestSent = true;
                    }
                    return;
                }

                if (message.reply && message.uEchoResponse) {
                    if (message.uEchoResponse.message !== 'Echo: Hello via raw WS') {
                        finish(new Error(`Unexpected WebSocket echo response: ${message.uEchoResponse.message}`));
                        ws.close();
                        return;
                    }
                    ws.close(1000);
                    finish();
                }
            });

            const timeout = setTimeout(() => {
                ws.close();
                finish(new Error('WebSocket SRPC test timed out'));
            }, 5000);
        });

        this.logger.info('  ✓ Raw WebSocket echo request');
        this.logger.info('[Test End] Raw WebSocket Client (backwards compatibility)');
    }

    private async testUnmatchedUpgradeRejection() {
        this.logger.info('[Test Start] Unmatched Upgrade Rejection');

        // Send a WebSocket upgrade request to a path no SrpcServer handles.
        // The fallback handler should respond with 400 and destroy the socket.
        await new Promise<void>((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const http = require('http');
            const req = http.request({
                hostname: 'localhost',
                port: this.httpPort,
                path: '/nonexistent-ws-path',
                headers: {
                    Connection: 'Upgrade',
                    Upgrade: 'websocket',
                    'Sec-WebSocket-Version': '13',
                    'Sec-WebSocket-Key': Buffer.from(uuid7()).toString('base64')
                }
            });

            const timeout = setTimeout(() => {
                req.destroy();
                reject(new Error('Unmatched upgrade test timed out — socket was not rejected'));
            }, 3000);

            req.on('upgrade', () => {
                clearTimeout(timeout);
                reject(new Error('Upgrade should not have succeeded for unmatched path'));
            });

            req.on('response', (res: { statusCode: number }) => {
                clearTimeout(timeout);
                if (res.statusCode === 400) {
                    resolve();
                } else {
                    reject(new Error(`Expected 400 but got ${res.statusCode}`));
                }
            });

            req.on('error', () => {
                // Socket destroyed before full response — also acceptable
                clearTimeout(timeout);
                resolve();
            });

            req.end();
        });

        this.logger.info('  ✓ Unmatched upgrade path rejected');
        this.logger.info('[Test End] Unmatched Upgrade Rejection');
    }

    private getServerSecret() {
        const secret = this.appConfig.SRPC_AUTH_SECRET;
        if (!secret) {
            throw new Error('SRPC authentication secret is not configured in AppConfig');
        }
        return secret;
    }

    private async waitForEvent(predicate: () => boolean, timeoutMs: number, errorMessage: string) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (predicate()) return;
            await sleepSecs(0.05);
        }
        throw new Error(errorMessage);
    }
}
