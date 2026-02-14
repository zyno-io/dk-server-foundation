import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { Socket } from 'net';

import { installUpgradeClaimHandling, isUpgradeClaimed, markUpgradeClaimed } from '../../src/srpc/SrpcServer';

describe('upgrade claim handling', () => {
    describe('isUpgradeClaimed / markUpgradeClaimed', () => {
        it('returns false for an unmarked socket', () => {
            const socket = new Socket();
            assert.equal(isUpgradeClaimed(socket), false);
        });

        it('returns true after markUpgradeClaimed', () => {
            const socket = new Socket();
            markUpgradeClaimed(socket);
            assert.equal(isUpgradeClaimed(socket), true);
        });
    });

    describe('installUpgradeClaimHandling', () => {
        it('stops propagation after a listener claims the socket', () => {
            const server = createServer();
            installUpgradeClaimHandling(server);

            const handlerA = mock.fn((_req: unknown, socket: Socket) => {
                markUpgradeClaimed(socket);
            });
            const handlerB = mock.fn();

            server.on('upgrade', handlerA);
            server.on('upgrade', handlerB);

            const socket = new Socket();
            server.emit('upgrade', {}, socket, Buffer.alloc(0));

            assert.equal(handlerA.mock.callCount(), 1);
            assert.equal(handlerB.mock.callCount(), 0);
        });

        it('propagates to all listeners when no one claims the socket', () => {
            const server = createServer();
            installUpgradeClaimHandling(server);

            const handlerA = mock.fn();
            const handlerB = mock.fn();

            server.on('upgrade', handlerA);
            server.on('upgrade', handlerB);

            const socket = new Socket();
            server.emit('upgrade', {}, socket, Buffer.alloc(0));

            assert.equal(handlerA.mock.callCount(), 1);
            assert.equal(handlerB.mock.callCount(), 1);
        });

        it('does not affect non-upgrade events', () => {
            const server = createServer();
            installUpgradeClaimHandling(server);

            const handler = mock.fn();
            server.on('request', handler);

            server.emit('request', {}, {});

            assert.equal(handler.mock.callCount(), 1);
        });

        it('is idempotent — calling twice does not double-patch', () => {
            const server = createServer();
            installUpgradeClaimHandling(server);
            installUpgradeClaimHandling(server);

            const handlerA = mock.fn((_req: unknown, socket: Socket) => {
                markUpgradeClaimed(socket);
            });
            const handlerB = mock.fn();

            server.on('upgrade', handlerA);
            server.on('upgrade', handlerB);

            const socket = new Socket();
            server.emit('upgrade', {}, socket, Buffer.alloc(0));

            // handlerA should be called exactly once (not twice from double-patch)
            assert.equal(handlerA.mock.callCount(), 1);
            assert.equal(handlerB.mock.callCount(), 0);
        });

        it('destroys unclaimed sockets via fallback', async () => {
            const server = createServer();
            installUpgradeClaimHandling(server);

            const socket = new Socket();
            const destroyFn = mock.fn();
            socket.destroy = destroyFn as any;
            socket.write = mock.fn() as any; // prevent write errors on unconnected socket

            server.emit('upgrade', {}, socket, Buffer.alloc(0));

            // Fallback uses setImmediate, so wait for it
            await new Promise(resolve => setImmediate(resolve));

            assert.equal(destroyFn.mock.callCount(), 1);
        });

        it('does not destroy claimed sockets via fallback', async () => {
            const server = createServer();
            installUpgradeClaimHandling(server);

            server.on('upgrade', (_req: unknown, socket: Socket) => {
                markUpgradeClaimed(socket);
            });

            const socket = new Socket();
            const destroyFn = mock.fn();
            socket.destroy = destroyFn as any;

            server.emit('upgrade', {}, socket, Buffer.alloc(0));

            await new Promise(resolve => setImmediate(resolve));

            assert.equal(destroyFn.mock.callCount(), 0);
        });

        it('respects prependListener ordering', () => {
            const server = createServer();

            // Register a "consumer" handler first
            const consumerHandler = mock.fn();
            server.on('upgrade', consumerHandler);

            // Then install claim handling + prepend an SrpcServer-like handler
            installUpgradeClaimHandling(server);

            server.prependListener('upgrade', (_req: unknown, socket: Socket) => {
                markUpgradeClaimed(socket);
            });

            const socket = new Socket();
            server.emit('upgrade', {}, socket, Buffer.alloc(0));

            // Consumer handler should NOT have been called
            assert.equal(consumerHandler.mock.callCount(), 0);
        });
    });
});
