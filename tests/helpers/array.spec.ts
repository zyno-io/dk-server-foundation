import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asyncMap, toArray } from '../../src/helpers/data/array';

describe('Array helpers', () => {
    describe('toArray', () => {
        it('converts single value to array', () => {
            assert.deepStrictEqual(toArray('test'), ['test']);
            assert.deepStrictEqual(toArray(123), [123]);
            assert.deepStrictEqual(toArray({ foo: 'bar' }), [{ foo: 'bar' }]);
        });

        it('returns array unchanged', () => {
            const arr = ['a', 'b', 'c'];
            assert.strictEqual(toArray(arr), arr);
            assert.deepStrictEqual(toArray(arr), ['a', 'b', 'c']);
        });

        it('handles empty array', () => {
            const arr: string[] = [];
            assert.strictEqual(toArray(arr), arr);
            assert.deepStrictEqual(toArray(arr), []);
        });

        it('handles null and undefined', () => {
            assert.deepStrictEqual(toArray(null), [null]);
            assert.deepStrictEqual(toArray(undefined), [undefined]);
        });
    });

    describe('asyncMap', () => {
        it('maps array asynchronously in order', async () => {
            const result = await asyncMap([1, 2, 3], async (item: number) => {
                return item * 2;
            });
            assert.deepStrictEqual(result, [2, 4, 6]);
        });

        it('provides index to callback', async () => {
            const result = await asyncMap(['a', 'b', 'c'], async (item: string, idx: number) => {
                return `${item}${idx}`;
            });
            assert.deepStrictEqual(result, ['a0', 'b1', 'c2']);
        });

        it('handles empty array', async () => {
            const result = await asyncMap([], async (item: any) => item);
            assert.deepStrictEqual(result, []);
        });

        it('executes sequentially not in parallel', async () => {
            const order: number[] = [];
            await asyncMap([1, 2, 3], async (item: number) => {
                order.push(item);
                await new Promise(resolve => setTimeout(resolve, 10 * (4 - item)));
                return item;
            });
            assert.deepStrictEqual(order, [1, 2, 3]);
        });

        it('handles async operations with delays', async () => {
            const result = await asyncMap([100, 50, 25], async (ms: number) => {
                await new Promise(resolve => setTimeout(resolve, ms));
                return ms * 2;
            });
            assert.deepStrictEqual(result, [200, 100, 50]);
        });

        it('propagates errors from callback', async () => {
            await assert.rejects(
                asyncMap([1, 2, 3], async (item: number) => {
                    if (item === 2) throw new Error('test error');
                    return item;
                }),
                { message: 'test error' }
            );
        });
    });
});
