import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractKV, extractUpdates, extractValues, objectAssign, objectEntries, objectKeys, patchObject } from '../../src/helpers/data/objects';

describe('Object helpers', () => {
    describe('objectKeys', () => {
        it('returns keys of object', () => {
            const obj = { a: 1, b: 2, c: 3 };
            assert.deepStrictEqual(objectKeys(obj), ['a', 'b', 'c']);
        });

        it('returns empty array for empty object', () => {
            assert.deepStrictEqual(objectKeys({}), []);
        });

        it('preserves type information', () => {
            const obj = { name: 'test', age: 25 };
            const keys: ('name' | 'age')[] = objectKeys(obj);
            assert.deepStrictEqual(keys, ['name', 'age']);
        });
    });

    describe('objectAssign', () => {
        it('assigns properties from sources to target', () => {
            const target = { a: 1, b: 2 };
            const result = objectAssign(target, { b: 3, c: 4 } as any);
            assert.deepStrictEqual(result, { a: 1, b: 3, c: 4 });
            assert.strictEqual(result, target);
        });

        it('handles multiple sources', () => {
            const target = { a: 1 };
            const result = objectAssign(target, { b: 2 } as any, { c: 3 } as any, { d: 4 } as any);
            assert.deepStrictEqual(result, { a: 1, b: 2, c: 3, d: 4 });
        });

        it('later sources override earlier ones', () => {
            const target = { a: 1 };
            const result = objectAssign(target, { a: 2 }, { a: 3 });
            assert.deepStrictEqual(result, { a: 3 });
        });
    });

    describe('objectEntries', () => {
        it('returns entries of object', () => {
            const obj = { a: 1, b: 2 };
            const entries = objectEntries(obj);
            assert.deepStrictEqual(entries, [
                ['a', 1],
                ['b', 2]
            ]);
        });

        it('returns empty array for empty object', () => {
            assert.deepStrictEqual(objectEntries({}), []);
        });
    });

    describe('extractValues', () => {
        it('extracts specified fields from object', () => {
            const obj = { a: 1, b: 2, c: 3, d: 4 };
            const result = extractValues(obj, ['a', 'c'] as const);
            assert.deepStrictEqual(result, { a: 1, c: 3 });
        });

        it('skips undefined fields', () => {
            const obj = { a: 1, b: undefined, c: 3 };
            const result = extractValues(obj, ['a', 'b', 'c'] as const);
            assert.deepStrictEqual(result, { a: 1, c: 3 });
        });

        it('returns empty object when no fields match', () => {
            const obj = { a: 1, b: 2 };
            const result = extractValues(obj, [] as const);
            assert.deepStrictEqual(result, {});
        });

        it('handles fields not present in object', () => {
            const obj = { a: 1, b: 2 };
            const result = extractValues(obj, ['a', 'c'] as any);
            assert.deepStrictEqual(result, { a: 1 });
        });
    });

    describe('extractUpdates', () => {
        it('returns only changed fields', () => {
            const state = { a: 1, b: 2, c: 3 };
            const updates = { a: 1, b: 3, c: 4 };
            const result = extractUpdates(state, updates);
            assert.deepStrictEqual(result, { b: 3, c: 4 });
        });

        it('skips undefined updates', () => {
            const state = { a: 1, b: 2 };
            const updates = { a: 2, b: undefined };
            const result = extractUpdates(state, updates);
            assert.deepStrictEqual(result, { a: 2 });
        });

        it('returns empty object when no changes', () => {
            const state = { a: 1, b: 2 };
            const updates = { a: 1, b: 2 };
            const result = extractUpdates(state, updates);
            assert.deepStrictEqual(result, {});
        });

        it('only checks specified fields when provided', () => {
            const state = { a: 1, b: 2, c: 3 };
            const updates = { a: 5, b: 6, c: 7 };
            const result = extractUpdates(state, updates, ['a', 'c']);
            assert.deepStrictEqual(result, { a: 5, c: 7 });
        });

        it('uses equals method for deep equality', () => {
            const state = { obj: { x: 1, y: 2 } };
            const updates = { obj: { x: 1, y: 2 } };
            const result = extractUpdates(state, updates);
            assert.deepStrictEqual(result, {});
        });

        it('uses matches method for partial object matching', () => {
            const state = { obj: { x: 1, y: 2, z: 3 } };
            const updates = { obj: { x: 1, y: 2 } } as any;
            const result = extractUpdates(state, updates, undefined, 'matches');
            assert.deepStrictEqual(result, {});
        });

        it('detects changes with matches method when values differ', () => {
            const state = { obj: { x: 1, y: 2, z: 3 } };
            const updates = { obj: { x: 1, y: 5 } } as any;
            const result = extractUpdates(state, updates, undefined, 'matches');
            assert.deepStrictEqual(result, { obj: { x: 1, y: 5 } });
        });
    });

    describe('patchObject', () => {
        it('applies only changed fields to object', () => {
            const state = { a: 1, b: 2, c: 3 };
            const updates = { a: 1, b: 5, c: 6 };
            const result = patchObject(state, updates);
            assert.strictEqual(result, state);
            assert.deepStrictEqual(result, { a: 1, b: 5, c: 6 });
        });

        it('does not modify object when no changes', () => {
            const state = { a: 1, b: 2 };
            const original = { ...state };
            patchObject(state, { a: 1, b: 2 });
            assert.deepStrictEqual(state, original);
        });

        it('only patches specified fields when provided', () => {
            const state = { a: 1, b: 2, c: 3 };
            patchObject(state, { a: 10, b: 20, c: 30 }, ['a', 'c']);
            assert.deepStrictEqual(state, { a: 10, b: 2, c: 30 });
        });

        it('uses matches method when specified', () => {
            const state = { obj: { x: 1, y: 2, z: 3 } };
            patchObject(state, { obj: { x: 1, y: 2 } } as any, undefined, 'matches');
            assert.deepStrictEqual(state, { obj: { x: 1, y: 2, z: 3 } });
        });
    });

    describe('extractKV', () => {
        it('converts array to key-value object', () => {
            const arr = [
                { id: 'a', value: 1 },
                { id: 'b', value: 2 },
                { id: 'c', value: 3 }
            ];
            const result = extractKV(arr, 'id', 'value');
            assert.deepStrictEqual(result, { a: 1, b: 2, c: 3 });
        });

        it('handles empty array', () => {
            const result = extractKV([], 'id', 'value');
            assert.deepStrictEqual(result, {});
        });

        it('overwrites duplicate keys', () => {
            const arr = [
                { id: 'a', value: 1 },
                { id: 'a', value: 2 }
            ];
            const result = extractKV(arr, 'id', 'value');
            assert.deepStrictEqual(result, { a: 2 });
        });

        it('works with different key and value types', () => {
            const arr = [
                { name: 'Alice', age: 25 },
                { name: 'Bob', age: 30 }
            ];
            const result = extractKV(arr, 'name', 'age');
            assert.deepStrictEqual(result, { Alice: 25, Bob: 30 });
        });

        it('handles complex value types', () => {
            const arr = [
                { id: '1', data: { x: 1, y: 2 } },
                { id: '2', data: { x: 3, y: 4 } }
            ];
            const result = extractKV(arr, 'id', 'data');
            assert.deepStrictEqual(result, {
                '1': { x: 1, y: 2 },
                '2': { x: 3, y: 4 }
            });
        });
    });
});
