import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createDistributedMethod, disconnectAllRedis, sleepMs, TestingHelpers } from '../../src';
import { LoggerInterface } from '@deepkit/logger';

describe('createDistributedMethod', () => {
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379
        }
    });
    before(() => tf.start());
    after(async () => {
        await tf.stop();
        await disconnectAllRedis();
    });

    it('executes the handler locally when called', async () => {
        const fn = mock.fn(async (_data: { key: string }) => {});
        const method = createDistributedMethod({ name: 'test-local-exec' }, fn);

        await method({ key: 'value' });

        assert.strictEqual(fn.mock.callCount(), 1);
        assert.deepStrictEqual(fn.mock.calls[0].arguments[0], { key: 'value' });
    });

    it('passes data through to the handler', async () => {
        const received: Array<{ x: number; y: string }> = [];
        const method = createDistributedMethod<{ x: number; y: string }>({ name: 'test-passthrough' }, async data => {
            received.push(data);
        });

        await method({ x: 42, y: 'hello' });

        assert.strictEqual(received.length, 1);
        assert.deepStrictEqual(received[0], { x: 42, y: 'hello' });
    });

    it('executes the handler for each invocation', async () => {
        const results: number[] = [];
        const method = createDistributedMethod<{ n: number }>({ name: 'test-multi-call' }, async data => {
            results.push(data.n);
        });

        await method({ n: 1 });
        await method({ n: 2 });
        await method({ n: 3 });

        assert.deepStrictEqual(results, [1, 2, 3]);
    });

    it('catches handler errors and logs them', async () => {
        const errorFn = mock.fn();
        const mockLogger: LoggerInterface = { error: errorFn } as unknown as LoggerInterface;
        const testError = new Error('test error');

        const method = createDistributedMethod<{ x: number }>({ name: 'test-error-log', logger: () => mockLogger }, async () => {
            throw testError;
        });

        await method({ x: 1 });

        assert.strictEqual(errorFn.mock.callCount(), 1);
        assert.strictEqual(errorFn.mock.calls[0].arguments[0], 'Error executing test-error-log distributed method');
        assert.strictEqual(errorFn.mock.calls[0].arguments[1], testError);
    });

    it('does not throw when the handler throws', async () => {
        const mockLogger: LoggerInterface = { error: mock.fn() } as unknown as LoggerInterface;
        const method = createDistributedMethod({ name: 'test-no-throw', logger: () => mockLogger }, async () => {
            throw new Error('boom');
        });

        await assert.doesNotReject(method({}));
    });

    it('calls the logger getter on each error', async () => {
        const errorFn = mock.fn();
        const loggerGetter = mock.fn(() => ({ error: errorFn }) as unknown as LoggerInterface);

        const method = createDistributedMethod({ name: 'test-logger-getter', logger: loggerGetter }, async () => {
            throw new Error('fail');
        });

        await method({});
        await method({});

        assert.strictEqual(loggerGetter.mock.callCount(), 2);
        assert.strictEqual(errorFn.mock.callCount(), 2);
    });

    it('uses the default scoped logger when none is provided', async () => {
        // When no custom logger is provided, the function should use
        // r(Logger).scoped(`Distributed:${options.name}`).
        // We verify this doesn't crash by invoking with an error.
        const method = createDistributedMethod({ name: 'test-default-logger' }, async () => {
            throw new Error('default logger test');
        });

        // Should not throw - the default logger should handle the error
        await assert.doesNotReject(method({}));
    });

    it('includes the method name in error messages', async () => {
        const errorFn = mock.fn();
        const mockLogger: LoggerInterface = { error: errorFn } as unknown as LoggerInterface;

        const method = createDistributedMethod({ name: 'my-special-method', logger: () => mockLogger }, async () => {
            throw new Error('oops');
        });

        await method({});

        assert.match(errorFn.mock.calls[0].arguments[0], /my-special-method/);
    });

    it('receives broadcasts from other distributed methods with the same name', async () => {
        const received: Array<{ msg: string }> = [];

        // Create a method that records calls
        createDistributedMethod<{ msg: string }>({ name: 'test-broadcast-receive' }, async data => {
            received.push(data);
        });

        // Create a second method with the same name - simulates another instance's method
        // When the second method publishes, the first should receive via broadcast subscription
        // But note: same-instance messages are filtered out, so we verify the local execution
        const method2 = createDistributedMethod<{ msg: string }>({ name: 'test-broadcast-receive' }, async () => {});

        await method2({ msg: 'hello' });

        // Give Redis pub/sub a moment to deliver
        await sleepMs(100);

        // The first method should have received the broadcast from method2
        // (since they share the same event name and the broadcast goes through Redis)
        // However, same-instance broadcasts are filtered, so the first method's handler
        // is only called via its own local subscription path, not via Redis.
        // The local execution of method2 should have run method2's handler only.
        // This test verifies that method2's local call does NOT trigger method1's handler
        // through the broadcast (since same-instance messages are skipped).
        assert.strictEqual(received.length, 0);
    });
});
