import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { identifyMessageType, sanitizeData } from '../../src/devconsole/devconsole.srpc';

describe('identifyMessageType', () => {
    it('returns the first non-base key with a non-null value', () => {
        assert.strictEqual(identifyMessageType({ requestId: '1', someRpc: { data: true } }), 'someRpc');
    });

    it('ignores all base message keys', () => {
        const baseOnly = {
            requestId: '1',
            reply: true,
            error: null,
            userError: undefined,
            trace: 'abc',
            pingPong: {},
            byteStreamOperation: {}
        };
        assert.strictEqual(identifyMessageType(baseOnly), 'unknown');
    });

    it('ignores keys with null or undefined values', () => {
        assert.strictEqual(identifyMessageType({ requestId: '1', myKey: null }), 'unknown');
        assert.strictEqual(identifyMessageType({ requestId: '1', myKey: undefined }), 'unknown');
    });

    it('returns first matching key when multiple non-base keys exist', () => {
        const result = identifyMessageType({ alpha: 1, beta: 2 });
        assert.strictEqual(result, 'alpha');
    });

    it('returns unknown for empty object', () => {
        assert.strictEqual(identifyMessageType({}), 'unknown');
    });
});

describe('sanitizeData', () => {
    it('passes through normal keys', () => {
        const data = { requestId: '1', someRpc: { payload: 'hello' } };
        assert.deepStrictEqual(sanitizeData(data), data);
    });

    it('strips trace key', () => {
        const result = sanitizeData({ requestId: '1', trace: 'long-trace-data', someRpc: true });
        assert.deepStrictEqual(result, { requestId: '1', someRpc: true });
    });

    it('simplifies byteStreamOperation with write', () => {
        const result = sanitizeData({
            byteStreamOperation: { streamId: 'abc', write: Buffer.from('data'), extra: 'stuff' }
        });
        assert.deepStrictEqual(result, {
            byteStreamOperation: { streamId: 'abc', operation: 'write' }
        });
    });

    it('simplifies byteStreamOperation with finish', () => {
        const result = sanitizeData({
            byteStreamOperation: { streamId: 'abc', finish: true }
        });
        assert.deepStrictEqual(result, {
            byteStreamOperation: { streamId: 'abc', operation: 'finish' }
        });
    });

    it('simplifies byteStreamOperation with destroy', () => {
        const result = sanitizeData({
            byteStreamOperation: { streamId: 'abc', destroy: true }
        });
        assert.deepStrictEqual(result, {
            byteStreamOperation: { streamId: 'abc', operation: 'destroy' }
        });
    });

    it('labels unknown byteStreamOperation', () => {
        const result = sanitizeData({
            byteStreamOperation: { streamId: 'abc' }
        });
        assert.deepStrictEqual(result, {
            byteStreamOperation: { streamId: 'abc', operation: 'unknown' }
        });
    });

    it('passes through falsy byteStreamOperation', () => {
        assert.deepStrictEqual(sanitizeData({ byteStreamOperation: null }), { byteStreamOperation: null });
        assert.deepStrictEqual(sanitizeData({ byteStreamOperation: undefined }), { byteStreamOperation: undefined });
    });
});
