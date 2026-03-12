import { createServer } from 'http';
import { Socket } from 'net';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import WebSocket from 'ws';

import { installWebSocketUpgradeHandler } from '../../src/srpc/WebSocketUpgradeHandler';

describe('websocket upgrade handling', () => {
    it('claims matched path upgrades before later listeners run', () => {
        const server = createServer();
        const consumerHandler = mock.fn();
        server.on('upgrade', consumerHandler);

        installWebSocketUpgradeHandler({
            httpServer: server,
            wsPath: '/ws',
            wsServer: { handleUpgrade: mock.fn(), emit: mock.fn() } as any,
            verifyClient: (_info, cb) => cb(false, 403, 'Forbidden')
        });

        const socket = new Socket();
        socket.write = mock.fn(() => true) as any;
        socket.destroy = mock.fn() as any;

        server.emit('upgrade', { url: '/ws?x=1' }, socket, Buffer.alloc(0));

        assert.equal(consumerHandler.mock.callCount(), 0);
    });

    it('allows unmatched upgrades to continue to later listeners', () => {
        const server = createServer();
        const consumerHandler = mock.fn();

        installWebSocketUpgradeHandler({
            httpServer: server,
            wsPath: '/ws',
            wsServer: new WebSocket.Server({ noServer: true }),
            verifyClient: (_info, cb) => cb(true)
        });
        server.on('upgrade', consumerHandler);

        const socket = new Socket();
        socket.write = mock.fn(() => true) as any;
        socket.destroy = mock.fn() as any;

        server.emit('upgrade', { url: '/other' }, socket, Buffer.alloc(0));

        assert.equal(consumerHandler.mock.callCount(), 1);
    });

    it('rejects unclaimed upgrades via delayed fallback', async () => {
        const server = createServer();

        installWebSocketUpgradeHandler({
            httpServer: server,
            wsPath: '/ws',
            wsServer: new WebSocket.Server({ noServer: true }),
            verifyClient: (_info, cb) => cb(true),
            unclaimedUpgradeRejectionDelayMs: 0
        });

        const socket = new Socket();
        const destroyFn = mock.fn();
        socket.write = mock.fn(() => true) as any;
        socket.destroy = destroyFn as any;

        server.emit('upgrade', { url: '/other' }, socket, Buffer.alloc(0));
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.equal(destroyFn.mock.callCount(), 1);
    });

    it('cancels fallback rejection when a handler writes a 101 response', async () => {
        const server = createServer();
        const handlerB = mock.fn();

        installWebSocketUpgradeHandler({
            httpServer: server,
            wsPath: '/ws',
            wsServer: new WebSocket.Server({ noServer: true }),
            verifyClient: (_info, cb) => cb(true),
            unclaimedUpgradeRejectionDelayMs: 0
        });

        server.on('upgrade', (_req: unknown, socket: Socket) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
        });
        server.on('upgrade', handlerB);

        const socket = new Socket();
        socket.write = mock.fn(() => true) as any;
        socket.destroy = mock.fn() as any;

        server.emit('upgrade', { url: '/other' }, socket, Buffer.alloc(0));
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.equal(handlerB.mock.callCount(), 0);
    });

    it('does not install duplicate handlers for the same path on one server', () => {
        const server = createServer();
        const wsServerA = { handleUpgrade: mock.fn(), emit: mock.fn() } as any;
        const wsServerB = { handleUpgrade: mock.fn(), emit: mock.fn() } as any;
        const verifyA = mock.fn((_info, cb) => cb(false, 403, 'Forbidden A'));
        const verifyB = mock.fn((_info, cb) => cb(false, 403, 'Forbidden B'));

        installWebSocketUpgradeHandler({
            httpServer: server,
            wsPath: '/ws',
            wsServer: wsServerA,
            verifyClient: verifyA
        });

        installWebSocketUpgradeHandler({
            httpServer: server,
            wsPath: '/ws',
            wsServer: wsServerB,
            verifyClient: verifyB
        });

        const socket = new Socket();
        socket.write = mock.fn(() => true) as any;
        socket.destroy = mock.fn() as any;

        server.emit('upgrade', { url: '/ws' }, socket, Buffer.alloc(0));

        assert.equal(verifyA.mock.callCount(), 1);
        assert.equal(verifyB.mock.callCount(), 0);
    });
});
