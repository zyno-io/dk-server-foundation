import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromJson, safeJsonStringify, toJson } from '../../src/helpers/data/serialization';

describe('Serialization helpers', () => {
    describe('toJson', () => {
        it('serializes string', () => {
            assert.strictEqual(toJson('test'), '"test"');
        });

        it('serializes number', () => {
            assert.strictEqual(toJson(42), '42');
            assert.strictEqual(toJson(3.14), '3.14');
        });

        it('serializes boolean', () => {
            assert.strictEqual(toJson(true), 'true');
            assert.strictEqual(toJson(false), 'false');
        });

        it('serializes null', () => {
            assert.strictEqual(toJson(null as any), 'null');
        });

        it('serializes object', () => {
            const obj = { name: 'Alice', age: 30 };
            assert.strictEqual(toJson(obj), '{"name":"Alice","age":30}');
        });

        it('serializes array', () => {
            const arr = [1, 2, 3];
            assert.strictEqual(toJson(arr), '[1,2,3]');
        });

        it('serializes nested structures', () => {
            const nested = {
                user: {
                    name: 'Bob',
                    tags: ['admin', 'user']
                }
            };
            assert.strictEqual(toJson(nested as any), '{"user":{"name":"Bob","tags":["admin","user"]}}');
        });

        it('handles empty object', () => {
            assert.strictEqual(toJson({}), '{}');
        });

        it('handles empty array', () => {
            assert.strictEqual(toJson([]), '[]');
        });

        it('handles undefined in objects', () => {
            const obj = { a: 1, b: undefined, c: 3 };
            assert.strictEqual(toJson(obj as any), '{"a":1,"c":3}');
        });
    });

    describe('fromJson', () => {
        it('deserializes string', () => {
            assert.strictEqual(fromJson('"test"'), 'test');
        });

        it('deserializes number', () => {
            assert.strictEqual(fromJson('42'), 42);
            assert.strictEqual(fromJson('3.14'), 3.14);
        });

        it('deserializes boolean', () => {
            assert.strictEqual(fromJson('true'), true);
            assert.strictEqual(fromJson('false'), false);
        });

        it('deserializes null', () => {
            assert.strictEqual(fromJson('null'), null);
        });

        it('deserializes object', () => {
            const result = fromJson<{ name: string; age: number }>('{"name":"Alice","age":30}');
            assert.deepStrictEqual(result, { name: 'Alice', age: 30 });
        });

        it('deserializes array', () => {
            const result = fromJson<number[]>('[1,2,3]');
            assert.deepStrictEqual(result, [1, 2, 3]);
        });

        it('deserializes nested structures', () => {
            const json = '{"user":{"name":"Bob","tags":["admin","user"]}}';
            const result = fromJson<{ user: { name: string; tags: string[] } }>(json);
            assert.deepStrictEqual(result, {
                user: {
                    name: 'Bob',
                    tags: ['admin', 'user']
                }
            });
        });

        it('handles empty object', () => {
            assert.deepStrictEqual(fromJson('{}'), {});
        });

        it('handles empty array', () => {
            assert.deepStrictEqual(fromJson('[]'), []);
        });

        it('throws on invalid JSON', () => {
            assert.throws(() => fromJson('invalid'));
            assert.throws(() => fromJson('{'));
            assert.throws(() => fromJson('{a:1}'));
        });
    });

    describe('safeJsonStringify', () => {
        it('serializes plain objects like JSON.stringify', () => {
            const obj = { a: 1, b: 'hello', c: [1, 2, 3] };
            assert.strictEqual(safeJsonStringify(obj), JSON.stringify(obj));
        });

        it('serializes primitives', () => {
            assert.strictEqual(safeJsonStringify(42), '42');
            assert.strictEqual(safeJsonStringify('hello'), '"hello"');
            assert.strictEqual(safeJsonStringify(null), 'null');
            assert.strictEqual(safeJsonStringify(true), 'true');
        });

        it('replaces true circular references with [Circular]', () => {
            const obj: any = { a: 1 };
            obj.self = obj;
            const result = JSON.parse(safeJsonStringify(obj));
            assert.strictEqual(result.a, 1);
            assert.strictEqual(result.self, '[Circular]');
        });

        it('handles deeply nested circular references', () => {
            const obj: any = { child: { grandchild: {} } };
            obj.child.grandchild.root = obj;
            const result = JSON.parse(safeJsonStringify(obj));
            assert.strictEqual(result.child.grandchild.root, '[Circular]');
        });

        it('preserves shared (non-circular) object references', () => {
            const shared = { x: 1, y: 2 };
            const obj = { a: shared, b: shared };
            const result = JSON.parse(safeJsonStringify(obj));
            assert.deepStrictEqual(result.a, { x: 1, y: 2 });
            assert.deepStrictEqual(result.b, { x: 1, y: 2 });
        });

        it('preserves shared arrays', () => {
            const shared = [1, 2, 3];
            const obj = { first: shared, second: shared };
            const result = JSON.parse(safeJsonStringify(obj));
            assert.deepStrictEqual(result.first, [1, 2, 3]);
            assert.deepStrictEqual(result.second, [1, 2, 3]);
        });

        it('handles circular reference within an array', () => {
            const arr: any[] = [1, 2];
            arr.push(arr);
            const result = JSON.parse(safeJsonStringify(arr));
            assert.strictEqual(result[0], 1);
            assert.strictEqual(result[1], 2);
            assert.strictEqual(result[2], '[Circular]');
        });

        it('handles mixed shared and circular references', () => {
            const shared = { val: 'shared' };
            const obj: any = { a: shared, b: { nested: shared } };
            obj.b.circular = obj;
            const result = JSON.parse(safeJsonStringify(obj));
            assert.deepStrictEqual(result.a, { val: 'shared' });
            assert.deepStrictEqual(result.b.nested, { val: 'shared' });
            assert.strictEqual(result.b.circular, '[Circular]');
        });
    });

    describe('round-trip serialization', () => {
        it('preserves object through round-trip', () => {
            const original = { name: 'Alice', age: 30, active: true };
            const serialized = toJson(original);
            const deserialized = fromJson(serialized);
            assert.deepStrictEqual(deserialized, original);
        });

        it('preserves array through round-trip', () => {
            const original = [1, 'two', { three: 3 }, [4, 5]] as any;
            const serialized = toJson(original);
            const deserialized = fromJson(serialized);
            assert.deepStrictEqual(deserialized, original);
        });

        it('preserves nested structure through round-trip', () => {
            const original = {
                users: [
                    { id: 1, name: 'Alice', metadata: { role: 'admin' } },
                    { id: 2, name: 'Bob', metadata: { role: 'user' } }
                ],
                count: 2
            } as any;
            const serialized = toJson(original);
            const deserialized = fromJson(serialized);
            assert.deepStrictEqual(deserialized, original);
        });

        it('handles special number values', () => {
            const original = { zero: 0, negative: -42, float: 3.14159 };
            const serialized = toJson(original);
            const deserialized = fromJson(serialized);
            assert.deepStrictEqual(deserialized, original);
        });
    });
});
