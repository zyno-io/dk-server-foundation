import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getErrorMessage, isError, toError, tryOrError, tryOrErrorSync, tryWithReject } from '../../src/helpers/utils/error';

describe('Error helpers', () => {
    describe('isError', () => {
        it('returns true for Error instances', () => {
            assert.strictEqual(isError(new Error('test')), true);
            assert.strictEqual(isError(new TypeError('test')), true);
            assert.strictEqual(isError(new RangeError('test')), true);
        });

        it('returns false for non-Error values', () => {
            assert.strictEqual(isError('error string'), false);
            assert.strictEqual(isError(123), false);
            assert.strictEqual(isError(null), false);
            assert.strictEqual(isError(undefined), false);
            assert.strictEqual(isError({}), false);
            assert.strictEqual(isError({ message: 'test' }), false);
        });
    });

    describe('getErrorMessage', () => {
        it('extracts message from Error', () => {
            const error = new Error('test error');
            assert.strictEqual(getErrorMessage(error), 'test error');
        });

        it('converts non-Error to string', () => {
            assert.strictEqual(getErrorMessage('string error'), 'string error');
            assert.strictEqual(getErrorMessage(123), '123');
            assert.strictEqual(getErrorMessage(null), 'null');
            assert.strictEqual(getErrorMessage(undefined), 'undefined');
        });

        it('handles objects', () => {
            const obj = { message: 'test' };
            assert.strictEqual(getErrorMessage(obj), '[object Object]');
        });
    });

    describe('toError', () => {
        it('returns Error unchanged', () => {
            const error = new Error('test');
            assert.strictEqual(toError(error), error);
        });

        it('converts string to Error', () => {
            const result = toError('error message');
            assert.ok(result instanceof Error);
            assert.strictEqual(result.message, 'error message');
        });

        it('converts number to Error', () => {
            const result = toError(123);
            assert.ok(result instanceof Error);
            assert.strictEqual(result.message, '123');
        });

        it('adds cause when provided', () => {
            const cause = new Error('cause error');
            const result = toError('main error', cause);
            assert.strictEqual(result.message, 'main error');
            assert.strictEqual((result as any).cause, cause);
        });

        it('converts cause to Error if not already', () => {
            const result = toError('main error', 'cause message');
            assert.strictEqual(result.message, 'main error');
            assert.ok((result as any).cause instanceof Error);
            assert.strictEqual((result as any).cause.message, 'cause message');
        });
    });

    describe('tryOrErrorSync', () => {
        it('returns result for successful function', () => {
            const result = tryOrErrorSync(() => {
                return 42;
            });
            assert.strictEqual(result, 42);
        });

        it('returns Error for throwing function', () => {
            const result = tryOrErrorSync(() => {
                throw new Error('test error');
            });
            assert.ok(result instanceof Error);
            assert.strictEqual((result as Error).message, 'test error');
        });

        it('converts thrown non-Error to Error', () => {
            const result = tryOrErrorSync(() => {
                throw 'string error';
            });
            assert.ok(result instanceof Error);
            assert.strictEqual((result as Error).message, 'string error');
        });

        it('works with complex return types', () => {
            const result = tryOrErrorSync(() => {
                return { a: 1, b: [2, 3] };
            });
            assert.deepStrictEqual(result, { a: 1, b: [2, 3] });
        });

        it('catches synchronous errors only', () => {
            const result = tryOrErrorSync(() => {
                JSON.parse('invalid json');
                return 'success';
            });
            assert.ok(result instanceof Error);
        });
    });

    describe('tryOrError', () => {
        it('returns result for successful async function', async () => {
            const result = await tryOrError(async () => {
                return 42;
            });
            assert.strictEqual(result, 42);
        });

        it('returns Error for rejecting async function', async () => {
            const result = await tryOrError(async () => {
                throw new Error('test error');
            });
            assert.ok(result instanceof Error);
            assert.strictEqual((result as Error).message, 'test error');
        });

        it('works with Promise.reject', async () => {
            const result = await tryOrError(async () => {
                return Promise.reject(new Error('rejected'));
            });
            assert.ok(result instanceof Error);
            assert.strictEqual((result as Error).message, 'rejected');
        });

        it('converts thrown non-Error to Error', async () => {
            const result = await tryOrError(async () => {
                throw 'string error';
            });
            assert.ok(result instanceof Error);
            assert.strictEqual((result as Error).message, 'string error');
        });

        it('works with delayed async operations', async () => {
            const result = await tryOrError(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return 'success';
            });
            assert.strictEqual(result, 'success');
        });

        it('catches errors in delayed async operations', async () => {
            const result = await tryOrError(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                throw new Error('delayed error');
            });
            assert.ok(result instanceof Error);
            assert.strictEqual((result as Error).message, 'delayed error');
        });
    });

    describe('tryWithReject', () => {
        it('resolves with return value on success', async () => {
            const result = await tryWithReject(async () => {
                return 42;
            });
            assert.strictEqual(result, 42);
        });

        it('rejects when function throws', async () => {
            await assert.rejects(
                tryWithReject(async () => {
                    throw new Error('test error');
                }),
                { message: 'test error' }
            );
        });

        it('allows manual rejection via reject callback', async () => {
            try {
                await tryWithReject(async reject => {
                    reject();
                    return 'never reached';
                });
                assert.fail('Expected rejection');
            } catch (err) {
                assert.strictEqual(err, undefined);
            }
        });

        it('allows manual rejection with error', async () => {
            try {
                await tryWithReject(async reject => {
                    setTimeout(() => reject(), 10);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    return 'never reached';
                });
                assert.fail('Expected rejection');
            } catch (err) {
                assert.strictEqual(err, undefined);
            }
        });

        it('resolves normally if reject is not called', async () => {
            const result = await tryWithReject(async _reject => {
                // reject function exists but not called
                return 'success';
            });
            assert.strictEqual(result, 'success');
        });

        it('catches thrown error', async () => {
            await assert.rejects(
                tryWithReject(async _reject => {
                    throw new Error('thrown error');
                }),
                { message: 'thrown error' }
            );
        });

        it('works with async operations', async () => {
            const result = await tryWithReject(async _reject => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return 'delayed success';
            });
            assert.strictEqual(result, 'delayed success');
        });
    });
});
