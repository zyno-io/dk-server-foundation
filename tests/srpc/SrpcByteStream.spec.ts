import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { SrpcByteStream, IByteStream, IByteStreamable } from '../../src/srpc/SrpcByteStream';

function createMockByteStreamable(): IByteStreamable & { mockByteStream: MockByteStream } {
    const mockByteStream = new MockByteStream();
    return {
        byteStream: mockByteStream,
        mockByteStream
    };
}

class MockByteStream implements IByteStream {
    parentStreamId = 'test-stream-id';
    private disconnectHandlers: Array<() => void> = [];
    private bufferedAmount = 0;

    writes: Array<{ streamId: number; data: unknown }> = [];
    finishes: number[] = [];
    destroys: Array<{ streamId: number; error?: Error }> = [];

    write(streamId: number, data: unknown): boolean {
        this.writes.push({ streamId, data });
        return true;
    }

    finish(streamId: number): void {
        this.finishes.push(streamId);
    }

    destroy(streamId: number, err?: Error): void {
        this.destroys.push({ streamId, error: err });
    }

    attachDisconnectHandler(handler: () => void): void {
        this.disconnectHandlers.push(handler);
    }

    detachDisconnectHandler(handler: () => void): void {
        const idx = this.disconnectHandlers.indexOf(handler);
        if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    }

    getBufferedAmount(): number {
        return this.bufferedAmount;
    }

    setBufferedAmount(amount: number): void {
        this.bufferedAmount = amount;
    }

    triggerDisconnect(): void {
        // Copy array to avoid mutation issues during iteration
        const handlers = this.disconnectHandlers.slice();
        for (const handler of handlers) {
            handler();
        }
    }
}

describe('SrpcByteStream', () => {
    describe('initialization', () => {
        it('uses configured start ID and step', () => {
            const streamable = createMockByteStreamable();
            SrpcByteStream.init(streamable, { startId: 10, step: 5 });

            const sender1 = SrpcByteStream.createSender(streamable);
            const sender2 = SrpcByteStream.createSender(streamable);

            assert.strictEqual(sender1.id, 10);
            assert.strictEqual(sender2.id, 15);
        });

        it('defaults to start=1 step=1 if not initialized', () => {
            const streamable = createMockByteStreamable();

            const sender1 = SrpcByteStream.createSender(streamable);
            const sender2 = SrpcByteStream.createSender(streamable);

            assert.strictEqual(sender1.id, 1);
            assert.strictEqual(sender2.id, 2);
        });
    });

    describe('createSender', () => {
        it('creates a sender with incrementing ID', () => {
            const streamable = createMockByteStreamable();

            const sender1 = SrpcByteStream.createSender(streamable);
            const sender2 = SrpcByteStream.createSender(streamable);

            assert.strictEqual(sender1.id, 1);
            assert.strictEqual(sender2.id, 2);
        });

        it('tracks sender in senders map', async () => {
            const streamable = createMockByteStreamable();

            const sender = SrpcByteStream.createSender(streamable);
            // Handle expected error to avoid unhandled rejection
            sender.on('error', () => {});

            // Access internal state via another sender operation
            // We verify tracking by checking destroySubstream can find it
            SrpcByteStream.destroySubstream(streamable, sender.id, 'test');
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(sender.destroyed, true);
        });
    });

    describe('createReceiver', () => {
        it('creates a receiver with given ID', () => {
            const streamable = createMockByteStreamable();

            const receiver = SrpcByteStream.createReceiver(streamable, 42);

            assert.strictEqual(receiver.id, 42);
        });

        it('throws if stream ID is not a number', () => {
            const streamable = createMockByteStreamable();

            assert.throws(
                () => {
                    SrpcByteStream.createReceiver(streamable, undefined as unknown as number);
                },
                { message: 'Missing stream ID' }
            );
        });

        it('throws if receiver with same ID already exists', () => {
            const streamable = createMockByteStreamable();

            SrpcByteStream.createReceiver(streamable, 1);

            assert.throws(
                () => {
                    SrpcByteStream.createReceiver(streamable, 1);
                },
                { message: 'Stream 1 already exists' }
            );
        });
    });

    describe('writeReceiver', () => {
        it('pushes data to existing receiver', async () => {
            const streamable = createMockByteStreamable();
            const receiver = SrpcByteStream.createReceiver(streamable, 1);
            const chunks: Buffer[] = [];
            const dataPromise = new Promise<void>(resolve => {
                receiver.on('data', chunk => {
                    chunks.push(chunk);
                    resolve();
                });
            });

            SrpcByteStream.writeReceiver(streamable, 1, Buffer.from('test'));
            await dataPromise;

            assert.strictEqual(chunks.length, 1);
            assert.strictEqual(chunks[0].toString(), 'test');
        });

        it('does not throw for non-existent receiver', () => {
            const streamable = createMockByteStreamable();

            // Should not throw - this is the key change being tested
            assert.doesNotThrow(() => {
                SrpcByteStream.writeReceiver(streamable, 999, Buffer.from('test'));
            });
        });
    });

    describe('finishReceiver', () => {
        it('ends existing receiver stream', async () => {
            const streamable = createMockByteStreamable();
            const receiver = SrpcByteStream.createReceiver(streamable, 1);
            const ended = new Promise<void>(resolve => receiver.on('end', resolve));

            SrpcByteStream.finishReceiver(streamable, 1);
            receiver.resume(); // Consume the stream to trigger end

            await ended;
        });

        it('does not throw for non-existent receiver', () => {
            const streamable = createMockByteStreamable();

            // Should not throw - this is the key change being tested
            assert.doesNotThrow(() => {
                SrpcByteStream.finishReceiver(streamable, 999);
            });
        });
    });

    describe('destroySubstream', () => {
        it('destroys receiver when found in receivers map', () => {
            const streamable = createMockByteStreamable();
            const receiver = SrpcByteStream.createReceiver(streamable, 1);

            SrpcByteStream.destroySubstream(streamable, 1);

            assert.strictEqual(receiver.destroyed, true);
        });

        it('destroys receiver with error message', async () => {
            const streamable = createMockByteStreamable();
            const receiver = SrpcByteStream.createReceiver(streamable, 1);
            // Use once to ensure error is handled
            const errorPromise = new Promise<Error>(resolve => {
                receiver.once('error', resolve);
            });

            SrpcByteStream.destroySubstream(streamable, 1, 'Remote error');

            const error = await errorPromise;
            assert.strictEqual(error.message, 'Remote error');
        });

        it('destroys sender when found in senders map (bidirectional abort)', () => {
            const streamable = createMockByteStreamable();
            const sender = SrpcByteStream.createSender(streamable);
            const senderId = sender.id;

            SrpcByteStream.destroySubstream(streamable, senderId);

            assert.strictEqual(sender.destroyed, true);
        });

        it('destroys sender with error message', async () => {
            const streamable = createMockByteStreamable();
            const sender = SrpcByteStream.createSender(streamable);
            const senderId = sender.id;
            // Use once to ensure error is handled
            const errorPromise = new Promise<Error>(resolve => {
                sender.once('error', resolve);
            });

            SrpcByteStream.destroySubstream(streamable, senderId, 'Receiver aborted');

            const error = await errorPromise;
            assert.strictEqual(error.message, 'Receiver aborted');
        });

        it('does not throw for non-existent substream', () => {
            const streamable = createMockByteStreamable();

            // Should not throw - handles gracefully
            assert.doesNotThrow(() => {
                SrpcByteStream.destroySubstream(streamable, 999);
            });
        });

        it('prioritizes receiver over sender with same ID', () => {
            const streamable = createMockByteStreamable();

            // Create receiver with ID 1
            const receiver = SrpcByteStream.createReceiver(streamable, 1);

            // Create sender - it will get ID 1 as well (first sender)
            const sender = SrpcByteStream.createSender(streamable);
            assert.strictEqual(sender.id, 1);

            // destroySubstream should destroy receiver first
            SrpcByteStream.destroySubstream(streamable, 1);

            assert.strictEqual(receiver.destroyed, true);
            assert.strictEqual(sender.destroyed, false);
        });
    });

    describe('cleanup', () => {
        it('removes sender from senders map on destroy', async () => {
            const streamable = createMockByteStreamable();
            const sender = SrpcByteStream.createSender(streamable);
            const senderId = sender.id;

            sender.destroy();
            await new Promise(resolve => setImmediate(resolve));

            // Verify sender is removed - destroying again should be a no-op
            // (we check this by seeing no additional destroy calls)
            const destroyCount = streamable.mockByteStream.destroys.length;
            SrpcByteStream.destroySubstream(streamable, senderId);
            assert.strictEqual(streamable.mockByteStream.destroys.length, destroyCount);
        });

        it('removes receiver from receivers map on end', async () => {
            const streamable = createMockByteStreamable();
            const receiver = SrpcByteStream.createReceiver(streamable, 1);

            SrpcByteStream.finishReceiver(streamable, 1);
            receiver.resume();
            await new Promise(resolve => receiver.on('end', resolve));
            await new Promise(resolve => setImmediate(resolve));

            // Verify receiver is removed - write should be ignored
            assert.doesNotThrow(() => {
                SrpcByteStream.writeReceiver(streamable, 1, Buffer.from('test'));
            });
        });
    });

    describe('disconnect handling', () => {
        it('destroys sender on disconnect', () => {
            const streamable = createMockByteStreamable();
            const sender = SrpcByteStream.createSender(streamable);

            streamable.mockByteStream.triggerDisconnect();

            assert.strictEqual(sender.destroyed, true);
        });

        it('destroys receiver on disconnect', () => {
            const streamable = createMockByteStreamable();
            const receiver = SrpcByteStream.createReceiver(streamable, 1);

            streamable.mockByteStream.triggerDisconnect();

            assert.strictEqual(receiver.destroyed, true);
        });
    });

    describe('writing data', () => {
        it('writes data to byte stream', () => {
            return new Promise<void>(resolve => {
                const streamable = createMockByteStreamable();
                const sender = SrpcByteStream.createSender(streamable);

                sender.write(Buffer.from('test'), () => {
                    assert.strictEqual(streamable.mockByteStream.writes.length, 1);
                    assert.strictEqual(streamable.mockByteStream.writes[0].streamId, sender.id);
                    resolve();
                });
            });
        });

        it('signals finish to byte stream on end', () => {
            return new Promise<void>(resolve => {
                const streamable = createMockByteStreamable();
                const sender = SrpcByteStream.createSender(streamable);

                sender.end(() => {
                    assert.ok(streamable.mockByteStream.finishes.includes(sender.id));
                    resolve();
                });
            });
        });

        it('signals destroy to byte stream on destroy', async () => {
            const streamable = createMockByteStreamable();
            const sender = SrpcByteStream.createSender(streamable);
            const senderId = sender.id;
            // Handle expected error to avoid unhandled rejection
            sender.on('error', () => {});

            sender.destroy(new Error('test error'));
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(streamable.mockByteStream.destroys.length, 1);
            assert.strictEqual(streamable.mockByteStream.destroys[0].streamId, senderId);
            assert.strictEqual(streamable.mockByteStream.destroys[0].error?.message, 'test error');
        });

        it('does not signal destroy when remotely destroyed', async () => {
            const streamable = createMockByteStreamable();
            const sender = SrpcByteStream.createSender(streamable);

            // Destroy via remote signal
            SrpcByteStream.destroySubstream(streamable, sender.id);
            await new Promise(resolve => setImmediate(resolve));

            // Should not send destroy back to remote
            assert.strictEqual(streamable.mockByteStream.destroys.length, 0);
        });
    });

    describe('Pending Receivers (Race Condition Handling)', () => {
        it('buffers writes for non-existent receiver and replays on create', async () => {
            const streamable = createMockByteStreamable();
            // Must initialize info structure (simulating connection start)
            SrpcByteStream.init(streamable, { startId: 1, step: 1 });

            // 1. Receive data for stream 100 (which doesn't exist yet)
            SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('chunk1'));
            SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('chunk2'));

            // 2. Create the receiver
            const receiver = SrpcByteStream.createReceiver(streamable, 100);

            // 3. Verify data is replayed
            const chunks: Buffer[] = [];
            receiver.on('data', chunk => chunks.push(chunk));

            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(chunks.length, 2);
            assert.strictEqual(chunks[0].toString(), 'chunk1');
            assert.strictEqual(chunks[1].toString(), 'chunk2');
        });

        it('buffers finish signal for non-existent receiver and ends on create', async () => {
            const streamable = createMockByteStreamable();
            SrpcByteStream.init(streamable, { startId: 1, step: 1 });

            // 1. Receive data then finish for stream 100
            SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('chunk1'));
            SrpcByteStream.finishReceiver(streamable, 100);

            // 2. Create the receiver
            const receiver = SrpcByteStream.createReceiver(streamable, 100);

            const chunks: Buffer[] = [];
            let hasEnded = false;

            receiver.on('data', chunk => chunks.push(chunk));
            receiver.on('end', () => {
                hasEnded = true;
            });

            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(chunks.length, 1);
            assert.strictEqual(chunks[0].toString(), 'chunk1');
            assert.strictEqual(hasEnded, true);
        });

        it('buffers destroy signal for non-existent receiver and destroys on create', async () => {
            const streamable = createMockByteStreamable();
            SrpcByteStream.init(streamable, { startId: 1, step: 1 });

            // 1. Receive destroy signal
            SrpcByteStream.destroySubstream(streamable, 100, 'Too slow');

            // 2. Create the receiver
            const receiver = SrpcByteStream.createReceiver(streamable, 100);

            let error: Error | undefined;
            receiver.on('error', e => {
                error = e;
            });

            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(receiver.destroyed, true);
            assert.notStrictEqual(error, undefined);
            assert.strictEqual(error?.message, 'Too slow');
        });

        it('fails pending receiver if creation times out', async () => {
            mock.timers.enable();
            try {
                const streamable = createMockByteStreamable();
                SrpcByteStream.init(streamable, { startId: 1, step: 1 });

                // 1. Receive data
                SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('test'));

                // 2. Fast forward time past TTL (5000ms)
                mock.timers.tick(5001);

                // 3. Create the receiver - should immediately error
                const receiver = SrpcByteStream.createReceiver(streamable, 100);

                let _error: Error | undefined;
                receiver.on('error', e => {
                    _error = e;
                });

                // Trigger any pending timers/immediates
                mock.timers.tick(0);
                // Allow process.nextTick/microtasks to run (destroy emits error on nextTick)
                await Promise.resolve();

                assert.strictEqual(receiver.destroyed, true);
                // Check errored property directly as event might have been missed or not emitted yet
                assert.notStrictEqual((receiver as any).errored, undefined);
                assert.strictEqual((receiver as any).errored.message, 'Pending receiver expired before creation');
            } finally {
                mock.timers.reset();
            }
        });

        it('fails pending receiver if buffer exceeds max size', async () => {
            const streamable = createMockByteStreamable();
            SrpcByteStream.init(streamable, { startId: 1, step: 1 });

            // 1. Fill buffer beyond 2MB limit
            const largeChunk = Buffer.alloc(1024 * 1024); // 1MB
            SrpcByteStream.writeReceiver(streamable, 100, largeChunk);
            SrpcByteStream.writeReceiver(streamable, 100, largeChunk);
            // 2MB + 1 byte triggers limit
            SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('1'));

            // 2. Create the receiver - should immediately error
            const receiver = SrpcByteStream.createReceiver(streamable, 100);

            let error: Error | undefined;
            receiver.on('error', e => {
                error = e;
            });

            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(receiver.destroyed, true);
            assert.strictEqual(error?.message, 'Pending receiver exceeded max buffered bytes');
        });

        it('ignores subsequent writes after pending receiver fails', async () => {
            const streamable = createMockByteStreamable();
            SrpcByteStream.init(streamable, { startId: 1, step: 1 });

            // 1. Fail it via max size
            const largeChunk = Buffer.alloc(1024 * 1024);
            SrpcByteStream.writeReceiver(streamable, 100, largeChunk);
            SrpcByteStream.writeReceiver(streamable, 100, largeChunk);
            SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('overflow'));

            // 2. More writes (should be ignored)
            SrpcByteStream.writeReceiver(streamable, 100, Buffer.from('ignored'));

            // 3. Create receiver
            const receiver = SrpcByteStream.createReceiver(streamable, 100);

            let receivedData = false;
            receiver.on('data', () => {
                receivedData = true;
            });

            let error: Error | undefined;
            receiver.on('error', e => {
                error = e;
            });

            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(receivedData, false);
            assert.strictEqual(error?.message, 'Pending receiver exceeded max buffered bytes');
        });
    });
});
