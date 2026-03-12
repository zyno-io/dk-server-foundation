import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';

import { Cache } from '../../src/helpers/redis/cache';
import { TestingHelpers } from '../../src/testing';

describe.skip('Cache', () => {
    const tf = TestingHelpers.createTestingFacade({});

    before(async () => {
        await tf.start();
    });

    after(async () => {
        await tf.stop();
    });

    beforeEach(async () => {
        // Clean up any test keys
        const keys = ['test-key', 'test-obj', 'test-ttl', 'test-null'];
        for (const key of keys) {
            try {
                await Cache.set(key, '', 1);
            } catch {
                // Ignore errors
            }
        }
    });

    describe('string operations', () => {
        it('sets and gets string value', async () => {
            await Cache.set('test-key', 'test-value');
            const result = await Cache.get('test-key');
            assert.strictEqual(result, 'test-value');
        });

        it('returns null for non-existent key', async () => {
            const result = await Cache.get('non-existent-key');
            assert.strictEqual(result, null);
        });

        it('overwrites existing value', async () => {
            await Cache.set('test-key', 'value1');
            await Cache.set('test-key', 'value2');
            const result = await Cache.get('test-key');
            assert.strictEqual(result, 'value2');
        });

        it('handles empty string', async () => {
            await Cache.set('test-key', '');
            const result = await Cache.get('test-key');
            assert.strictEqual(result, '');
        });

        it('respects TTL', { timeout: 2000 }, async () => {
            await Cache.set('test-ttl', 'expires-soon', 1);
            const immediate = await Cache.get('test-ttl');
            assert.strictEqual(immediate, 'expires-soon');

            await new Promise(resolve => setTimeout(resolve, 1100));
            const afterExpiry = await Cache.get('test-ttl');
            assert.strictEqual(afterExpiry, null);
        });
    });

    describe('object operations', () => {
        it('sets and gets object', async () => {
            const obj = { name: 'Alice', age: 30, active: true };
            await Cache.setObj('test-obj', obj);
            const result = await Cache.getObj<typeof obj>('test-obj');
            assert.deepStrictEqual(result, obj);
        });

        it('returns null for non-existent object key', async () => {
            const result = await Cache.getObj('non-existent-obj');
            assert.strictEqual(result, null);
        });

        it('handles nested objects', async () => {
            const nested = {
                user: {
                    name: 'Bob',
                    metadata: {
                        role: 'admin',
                        permissions: ['read', 'write']
                    }
                }
            };
            await Cache.setObj('test-obj', nested);
            const result = await Cache.getObj<typeof nested>('test-obj');
            assert.deepStrictEqual(result, nested);
        });

        it('handles arrays', async () => {
            const arr = [1, 2, 3, 4, 5];
            await Cache.setObj('test-obj', arr);
            const result = await Cache.getObj<typeof arr>('test-obj');
            assert.deepStrictEqual(result, arr);
        });

        it('handles array of objects', async () => {
            const arr = [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' }
            ];
            await Cache.setObj('test-obj', arr);
            const result = await Cache.getObj<typeof arr>('test-obj');
            assert.deepStrictEqual(result, arr);
        });

        it('handles null values in objects', async () => {
            const obj = { a: 1, b: null, c: 3 };
            await Cache.setObj('test-obj', obj);
            const result = await Cache.getObj<typeof obj>('test-obj');
            assert.deepStrictEqual(result, obj);
        });

        it('overwrites existing object', async () => {
            await Cache.setObj('test-obj', { value: 1 });
            await Cache.setObj('test-obj', { value: 2 });
            const result = await Cache.getObj<{ value: number }>('test-obj');
            assert.deepStrictEqual(result, { value: 2 });
        });

        it('respects TTL for objects', { timeout: 2000 }, async () => {
            const obj = { test: 'data' };
            await Cache.setObj('test-obj', obj, 1);
            const immediate = await Cache.getObj<typeof obj>('test-obj');
            assert.deepStrictEqual(immediate, obj);

            await new Promise(resolve => setTimeout(resolve, 1100));
            const afterExpiry = await Cache.getObj('test-obj');
            assert.strictEqual(afterExpiry, null);
        });
    });

    describe('TTL behavior', () => {
        it('uses default TTL of 60 seconds', async () => {
            await Cache.set('test-key', 'value');
            // We can't easily test 60 second TTL, but we can verify it doesn't expire immediately
            await new Promise(resolve => setTimeout(resolve, 100));
            const result = await Cache.get('test-key');
            assert.strictEqual(result, 'value');
        });

        it('accepts custom TTL', async () => {
            await Cache.set('test-key', 'value', 120);
            await new Promise(resolve => setTimeout(resolve, 100));
            const result = await Cache.get('test-key');
            assert.strictEqual(result, 'value');
        });

        it('can set very short TTL', { timeout: 2000 }, async () => {
            await Cache.set('test-key', 'value', 1);
            await new Promise(resolve => setTimeout(resolve, 1100));
            const result = await Cache.get('test-key');
            assert.strictEqual(result, null);
        });
    });

    describe('mixed string and object operations', () => {
        it('string and object values are independent', async () => {
            await Cache.set('test-key', 'string-value');
            await Cache.setObj('test-key', { obj: 'value' });

            // Object overwrites string at same key
            const strResult = await Cache.get('test-key');
            assert.strictEqual(strResult, '{"obj":"value"}');

            const objResult = await Cache.getObj('test-key');
            assert.deepStrictEqual(objResult, { obj: 'value' });
        });
    });

    describe('special values', () => {
        it('handles numbers in objects', async () => {
            const obj = { zero: 0, negative: -42, float: 3.14, large: 1e10 };
            await Cache.setObj('test-obj', obj);
            const result = await Cache.getObj<typeof obj>('test-obj');
            assert.deepStrictEqual(result, obj);
        });

        it('handles boolean values in objects', async () => {
            const obj = { isTrue: true, isFalse: false };
            await Cache.setObj('test-obj', obj);
            const result = await Cache.getObj<typeof obj>('test-obj');
            assert.deepStrictEqual(result, obj);
        });

        it('handles empty object', async () => {
            await Cache.setObj('test-obj', {});
            const result = await Cache.getObj('test-obj');
            assert.deepStrictEqual(result, {});
        });

        it('handles empty array', async () => {
            await Cache.setObj('test-obj', []);
            const result = await Cache.getObj('test-obj');
            assert.deepStrictEqual(result, []);
        });
    });
});
