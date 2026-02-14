import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { serializeError } from '../../src/devconsole/patches';

describe('serializeError', () => {
    it('serializes a basic Error', () => {
        const err = new Error('something failed');
        const result = serializeError(err);
        assert.strictEqual(result.name, 'Error');
        assert.strictEqual(result.message, 'something failed');
        assert.ok(typeof result.stack === 'string');
    });

    it('serializes a TypeError', () => {
        const err = new TypeError('not a function');
        const result = serializeError(err);
        assert.strictEqual(result.name, 'TypeError');
        assert.strictEqual(result.message, 'not a function');
    });

    it('includes custom enumerable properties', () => {
        const err = new Error('fail');
        (err as any).statusCode = 404;
        (err as any).context = { path: '/foo' };
        const result = serializeError(err);
        assert.strictEqual(result.statusCode, 404);
        assert.deepStrictEqual(result.context, { path: '/foo' });
    });

    it('does not duplicate name, message, stack, cause in custom props', () => {
        const err = new Error('fail');
        const result = serializeError(err);
        // These should come from the standard extraction, not from iterating keys
        const keys = Object.keys(result);
        const nameCount = keys.filter(k => k === 'name').length;
        assert.strictEqual(nameCount, 1);
    });

    it('serializes Error cause recursively', () => {
        const inner = new Error('root cause');
        const outer = new Error('wrapper');
        (outer as any).cause = inner;
        const result = serializeError(outer);
        assert.ok(result.cause);
        assert.strictEqual(result.cause!.name, 'Error');
        assert.strictEqual(result.cause!.message, 'root cause');
    });

    it('handles non-Error cause', () => {
        const err = new Error('fail');
        (err as any).cause = 'string cause';
        const result = serializeError(err);
        assert.ok(result.cause);
        assert.strictEqual(result.cause!.name, 'Error');
        assert.strictEqual(result.cause!.message, 'string cause');
    });

    it('handles deeply nested cause chain', () => {
        const c = new Error('level 3');
        const b = new Error('level 2');
        (b as any).cause = c;
        const a = new Error('level 1');
        (a as any).cause = b;
        const result = serializeError(a);
        assert.strictEqual(result.message, 'level 1');
        assert.strictEqual(result.cause!.message, 'level 2');
        assert.strictEqual(result.cause!.cause!.message, 'level 3');
        assert.strictEqual(result.cause!.cause!.cause, undefined);
    });

    it('handles non-Error input (string)', () => {
        const result = serializeError('not an error');
        assert.strictEqual(result.name, 'Error');
        assert.strictEqual(result.message, 'not an error');
        assert.strictEqual(result.stack, undefined);
    });

    it('handles non-Error input (number)', () => {
        const result = serializeError(42);
        assert.strictEqual(result.name, 'Error');
        assert.strictEqual(result.message, '42');
    });

    it('handles non-Error input (null)', () => {
        const result = serializeError(null);
        assert.strictEqual(result.name, 'Error');
        assert.strictEqual(result.message, 'null');
    });

    it('handles non-Error input (undefined)', () => {
        const result = serializeError(undefined);
        assert.strictEqual(result.name, 'Error');
        assert.strictEqual(result.message, 'undefined');
    });

    it('handles error without cause', () => {
        const err = new Error('no cause');
        const result = serializeError(err);
        assert.strictEqual(result.cause, undefined);
    });
});
