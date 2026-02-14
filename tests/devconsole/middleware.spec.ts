import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DevConsoleLocalhostMiddleware } from '../../src/devconsole/devconsole.middleware';

function makeRequest(remoteAddress: string, headers: Record<string, string> = {}) {
    return { socket: { remoteAddress }, headers } as any;
}

const response = {} as any;

describe('DevConsoleLocalhostMiddleware', () => {
    const middleware = new DevConsoleLocalhostMiddleware();

    it('allows IPv4 localhost', () => {
        assert.doesNotThrow(() => middleware.handle(makeRequest('127.0.0.1'), response));
    });

    it('allows IPv6 localhost', () => {
        assert.doesNotThrow(() => middleware.handle(makeRequest('::1'), response));
    });

    it('allows IPv4-mapped IPv6 localhost', () => {
        assert.doesNotThrow(() => middleware.handle(makeRequest('::ffff:127.0.0.1'), response));
    });

    it('rejects external IPv4 address', () => {
        assert.throws(() => middleware.handle(makeRequest('192.168.1.100'), response), /Forbidden/);
    });

    it('rejects external IPv6 address', () => {
        assert.throws(() => middleware.handle(makeRequest('::ffff:192.168.1.1'), response), /Forbidden/);
    });

    it('rejects empty remote address', () => {
        assert.throws(() => middleware.handle({ socket: { remoteAddress: undefined }, headers: {} } as any, response), /Forbidden/);
    });

    it('rejects localhost with x-forwarded-for header (reverse proxy)', () => {
        assert.throws(() => middleware.handle(makeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.50' }), response), /Forbidden/);
    });

    it('rejects localhost with x-real-ip header (reverse proxy)', () => {
        assert.throws(() => middleware.handle(makeRequest('127.0.0.1', { 'x-real-ip': '203.0.113.50' }), response), /Forbidden/);
    });
});
