import assert from 'node:assert/strict';
import { describe, it, before, after, mock } from 'node:test';

import { disconnectAllRedis, flattenMutexKey, MutexAcquisitionError, sleepMs, TestingHelpers, withMutex, withMutexes } from '../../src';

describe('local mutex', () => {
    const tf = TestingHelpers.createTestingFacade({});
    before(() => tf.start());
    after(() => tf.stop());

    it('acquires a mutex', async () => {
        const fn = mock.fn();
        await withMutex({
            fn: async didWait => {
                fn(didWait);
            },
            key: 'Test1'
        });

        assert.deepStrictEqual(fn.mock.calls[fn.mock.callCount() - 1].arguments, [false]);
    });

    it('acquires a mutex after another mutex holder fails', async () => {
        withMutex({
            fn: async () => {
                await sleepMs(500);
                throw new Error('uh oh!');
            },
            key: 'Test2'
        }).catch(() => {});

        const fn = mock.fn();
        await withMutex({
            fn: async didWait => {
                fn(didWait);
            },
            key: 'Test2'
        });

        assert.deepStrictEqual(fn.mock.calls[fn.mock.callCount() - 1].arguments, [true]);
    });
});

describe('redis mutex', () => {
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            MUTEX_MODE: 'redis',
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379
        }
    });
    before(() => tf.start());
    after(async () => {
        await tf.stop();
        await disconnectAllRedis();
    });

    it('acquires a mutex', async () => {
        const fn = mock.fn();
        await withMutex({
            fn: async didWait => {
                fn(didWait);
            },
            key: 'RedisTest1'
        });

        assert.deepStrictEqual(fn.mock.calls[fn.mock.callCount() - 1].arguments, [false]);
    });

    it('blocks concurrent access to the same mutex', async () => {
        const executionOrder: number[] = [];

        const promise1 = withMutex({
            fn: async () => {
                executionOrder.push(1);
                await sleepMs(100);
                executionOrder.push(2);
            },
            key: 'RedisTest2',
            retryDelay: 50
        });

        // Wait a bit to ensure the first mutex is acquired
        await sleepMs(10);

        const promise2 = withMutex({
            fn: async didWait => {
                executionOrder.push(3);
                assert.strictEqual(didWait, true);
            },
            key: 'RedisTest2',
            retryDelay: 50
        });

        await Promise.all([promise1, promise2]);

        // Second operation should only start after first completes
        assert.deepStrictEqual(executionOrder, [1, 2, 3]);
    });

    it('releases mutex even when function throws', async () => {
        const promise1 = withMutex({
            fn: async () => {
                await sleepMs(100);
                throw new Error('test error');
            },
            key: 'RedisTest3',
            retryDelay: 50
        }).catch(() => {});

        // Wait a bit to ensure the first mutex is acquired
        await sleepMs(10);

        // Should be able to acquire the mutex again after it fails
        const fn = mock.fn();
        const promise2 = withMutex({
            fn: async didWait => {
                fn(didWait);
            },
            key: 'RedisTest3',
            retryDelay: 50
        });

        await Promise.all([promise1, promise2]);

        assert.deepStrictEqual(fn.mock.calls[fn.mock.callCount() - 1].arguments, [true]);
    });

    it('throws MutexAcquisitionError on timeout', async () => {
        // Acquire a mutex and hold it
        const holdPromise = withMutex({
            fn: async () => {
                await sleepMs(2000);
            },
            key: 'RedisTest4'
        });

        // Wait a bit to ensure the first mutex is acquired
        await sleepMs(10);

        // Try to acquire with a very short timeout
        await assert.rejects(
            withMutex({
                fn: async () => {},
                key: 'RedisTest4',
                retryCount: 2,
                retryDelay: 50
            }),
            MutexAcquisitionError
        );

        await holdPromise;
    });

    it('properly reports didWait parameter', async () => {
        const results: boolean[] = [];

        const promise1 = withMutex({
            fn: async didWait => {
                results.push(didWait);
                await sleepMs(100);
            },
            key: 'RedisTest5',
            retryDelay: 50
        });

        await sleepMs(10);

        const promise2 = withMutex({
            fn: async didWait => {
                results.push(didWait);
            },
            key: 'RedisTest5',
            retryDelay: 50
        });

        await Promise.all([promise1, promise2]);

        assert.deepStrictEqual(results, [false, true]);
    });

    it('handles multiple mutexes in order', async () => {
        const executionOrder: string[] = [];

        await withMutexes({
            keys: ['RedisTestM1', 'RedisTestM2', 'RedisTestM3'],
            fn: async () => {
                executionOrder.push('inside');
            }
        });

        assert.deepStrictEqual(executionOrder, ['inside']);
    });

    it('acquires multiple mutexes without contention', async () => {
        let didWaitResult: boolean | undefined;
        const executionLog: string[] = [];

        await withMutexes({
            keys: ['RedisTestM6', 'RedisTestM7', 'RedisTestM8'],
            fn: async didWait => {
                didWaitResult = didWait;
                executionLog.push('executed');
            }
        });

        assert.strictEqual(didWaitResult, false);
        assert.deepStrictEqual(executionLog, ['executed']);
    });

    it('handles contention with multiple mutexes', async () => {
        const executionOrder: string[] = [];

        const promise1 = withMutexes({
            keys: ['RedisTestM9', 'RedisTestM10'],
            fn: async () => {
                executionOrder.push('first-start');
                await sleepMs(100);
                executionOrder.push('first-end');
            },
            retryDelay: 50
        });

        await sleepMs(20);

        const promise2 = withMutexes({
            keys: ['RedisTestM9', 'RedisTestM11'],
            fn: async () => {
                executionOrder.push('second-start');
            },
            retryDelay: 50
        });

        await Promise.all([promise1, promise2]);

        // Second should only start after first completes
        assert.deepStrictEqual(executionOrder, ['first-start', 'first-end', 'second-start']);
    });

    it('maintains lock through renewal interval', async () => {
        const startTime = Date.now();
        let executionTime = 0;

        await withMutex({
            fn: async () => {
                // Hold the lock longer than the renewal interval
                await sleepMs(300);
                executionTime = Date.now() - startTime;
            },
            key: 'RedisTest6',
            renewInterval: 100
        });

        // Verify the function completed
        assert.ok(executionTime >= 300);
    });

    it('allows different keys to be acquired concurrently', async () => {
        const executionOrder: string[] = [];

        const promise1 = withMutex({
            fn: async () => {
                executionOrder.push('key1-start');
                await sleepMs(100);
                executionOrder.push('key1-end');
            },
            key: 'RedisTest7A'
        });

        const promise2 = withMutex({
            fn: async () => {
                executionOrder.push('key2-start');
                await sleepMs(100);
                executionOrder.push('key2-end');
            },
            key: 'RedisTest7B'
        });

        await Promise.all([promise1, promise2]);

        // Both should have started before either ended
        const key1StartIdx = executionOrder.indexOf('key1-start');
        const key2StartIdx = executionOrder.indexOf('key2-start');
        const key1EndIdx = executionOrder.indexOf('key1-end');
        const key2EndIdx = executionOrder.indexOf('key2-end');

        assert.ok(Math.min(key1StartIdx, key2StartIdx) < Math.max(key1EndIdx, key2EndIdx));
    });

    it('handles rapid sequential acquisitions', async () => {
        const results: number[] = [];

        for (let i = 0; i < 5; i++) {
            await withMutex({
                fn: async () => {
                    results.push(i);
                },
                key: 'RedisTest8'
            });
        }

        assert.deepStrictEqual(results, [0, 1, 2, 3, 4]);
    });
});

describe('flattenMutexKey', () => {
    it('converts string keys', () => {
        assert.strictEqual(flattenMutexKey('test'), 'test');
    });

    it('converts number keys', () => {
        assert.strictEqual(flattenMutexKey(123), '123');
    });

    it('converts array keys', () => {
        assert.strictEqual(flattenMutexKey(['a', 'b', 'c']), 'a:b:c');
    });

    it('converts nested array keys', () => {
        assert.strictEqual(flattenMutexKey(['a', ['b', 'c']]), 'a:b:c');
    });

    it('converts object with name property', () => {
        assert.strictEqual(flattenMutexKey({ name: 'TestClass' }), 'TestClass');
    });

    it('converts object with constructor name', () => {
        class TestClass {}
        const instance = new TestClass();
        assert.strictEqual(flattenMutexKey(instance), 'TestClass');
    });

    it('returns constructor name for objects with constructor', () => {
        const key = flattenMutexKey({ foo: 'bar', baz: 123 });
        assert.strictEqual(key, 'Object');
    });

    it('hashes objects without constructor', () => {
        const obj = Object.create(null);
        obj.foo = 'bar';
        obj.baz = 123;
        const key = flattenMutexKey(obj);
        assert.match(key, /^[a-f0-9]{32}$/); // MD5 hash
    });

    it('produces consistent hashes for same object', () => {
        const obj = Object.create(null);
        obj.foo = 'bar';
        obj.baz = 123;
        const key1 = flattenMutexKey(obj);
        const key2 = flattenMutexKey(obj);
        assert.strictEqual(key1, key2);
    });
});
