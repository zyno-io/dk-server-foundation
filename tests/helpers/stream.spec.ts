import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Readable, Writable } from 'stream';

import { PipeError, safePipe, withResourceCleanup } from '../../src/helpers/io/stream';

describe('Stream helpers', () => {
    describe('PipeError', () => {
        it('creates error with cause and side', () => {
            const cause = new Error('test error');
            const error = new PipeError(cause, 'input');
            assert.strictEqual(error.message, 'test error');
            assert.strictEqual(error.cause, cause);
            assert.strictEqual(error.side, 'input');
        });

        it('supports output side', () => {
            const cause = new Error('output failed');
            const error = new PipeError(cause, 'output');
            assert.strictEqual(error.side, 'output');
        });
    });

    describe('safePipe', () => {
        it('pipes data from input to output successfully', async () => {
            const input = Readable.from(['hello', ' ', 'world']);
            const chunks: Buffer[] = [];
            const output = new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(chunk);
                    callback();
                }
            });

            await safePipe(input, output);
            const result = Buffer.concat(chunks).toString();
            assert.strictEqual(result, 'hello world');
        });

        it('handles empty stream', async () => {
            const input = Readable.from([]);
            const chunks: Buffer[] = [];
            const output = new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(chunk);
                    callback();
                }
            });

            await safePipe(input, output);
            assert.deepStrictEqual(chunks, []);
        });

        it('handles large data', async () => {
            const data = 'x'.repeat(10000);
            const input = Readable.from([data]);
            const chunks: Buffer[] = [];
            const output = new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(chunk);
                    callback();
                }
            });

            await safePipe(input, output);
            const result = Buffer.concat(chunks).toString();
            assert.strictEqual(result, data);
        });

        it('rejects with PipeError on input error', async () => {
            const input = new Readable({
                read() {
                    process.nextTick(() => this.emit('error', new Error('input error')));
                }
            });
            const output = new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                }
            });

            const error = await safePipe(input, output).catch(e => e);
            assert.ok(error instanceof PipeError);
            assert.strictEqual(error.side, 'input');
            assert.strictEqual(error.cause.message, 'input error');
        });

        it('rejects with PipeError on output error', async () => {
            const input = Readable.from(['test']);
            const output = new Writable({
                write(_chunk, _encoding, callback) {
                    callback(new Error('output error'));
                }
            });

            const error = await safePipe(input, output).catch(e => e);
            assert.ok(error instanceof PipeError);
            assert.strictEqual(error.side, 'output');
        });

        it('destroys output stream on input error', async () => {
            const input = new Readable({
                read() {
                    process.nextTick(() => this.emit('error', new Error('test')));
                }
            });
            const output = new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                }
            });

            await safePipe(input, output).catch(() => {});
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(output.destroyed, true);
        });

        it('destroys input stream on output error', async () => {
            const input = Readable.from(['test']);
            const output = new Writable({
                write(_chunk, _encoding, callback) {
                    callback(new Error('test'));
                }
            });

            await safePipe(input, output).catch(() => {});
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(input.destroyed, true);
        });
    });

    describe('withResourceCleanup', () => {
        it('resolves with return value', async () => {
            const result = await withResourceCleanup(async () => {
                return 'success';
            });
            assert.strictEqual(result, 'success');
        });

        it('tracks and cleans up streams', async () => {
            const stream1 = Readable.from(['test']);
            const stream2 = new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                }
            });

            await withResourceCleanup(async tracker => {
                tracker.addStream(stream1);
                tracker.addStream(stream2);
                return 'done';
            });

            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(stream1.destroyed, true);
            assert.strictEqual(stream2.destroyed, true);
        });

        it('does not destroy already destroyed streams', async () => {
            const stream = Readable.from(['test']);
            stream.destroy();

            await withResourceCleanup(async tracker => {
                tracker.addStream(stream);
                return 'done';
            });

            assert.strictEqual(stream.destroyed, true);
        });

        it('cleans up resources on error', async () => {
            const stream = Readable.from(['test']);

            await withResourceCleanup(async tracker => {
                tracker.addStream(stream);
                throw new Error('test error');
            }).catch(() => {});

            assert.strictEqual(stream.destroyed, true);
        });

        it('calls onError callback on error', async () => {
            const onError = mock.fn();
            const testError = new Error('test error');

            await withResourceCleanup(async () => {
                throw testError;
            }, onError).catch(() => {});

            assert.strictEqual(onError.mock.callCount(), 1);
            assert.strictEqual(onError.mock.calls[0].arguments[0], testError);
        });

        it('rejects with error', async () => {
            await assert.rejects(
                withResourceCleanup(async () => {
                    throw new Error('test error');
                }),
                { message: 'test error' }
            );
        });

        it('works with async operations', async () => {
            const result = await withResourceCleanup(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return 'delayed';
            });
            assert.strictEqual(result, 'delayed');
        });

        it('handles multiple streams', async () => {
            const streams = [Readable.from(['a']), Readable.from(['b']), Readable.from(['c'])];

            await withResourceCleanup(async tracker => {
                streams.forEach(s => tracker.addStream(s));
                return 'done';
            });

            await new Promise(resolve => setImmediate(resolve));
            streams.forEach(stream => {
                assert.strictEqual(stream.destroyed, true);
            });
        });
    });
});
