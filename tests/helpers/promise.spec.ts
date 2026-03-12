import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSemaphore } from '../../src/helpers/async/promise';

describe('Promise helpers', () => {
    describe('createSemaphore', () => {
        it('creates a semaphore that can be released', async () => {
            const semaphore = createSemaphore();
            let resolved = false;

            semaphore.promise.then(() => {
                resolved = true;
            });

            assert.strictEqual(resolved, false);
            semaphore.release();

            await semaphore.promise;
            assert.strictEqual(resolved, true);
        });

        it('allows waiting on promise before releasing', async () => {
            const semaphore = createSemaphore();
            const start = Date.now();

            setTimeout(() => {
                semaphore.release();
            }, 50);

            await semaphore.promise;
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 45);
        });

        it('throws error when releasing twice', async () => {
            const semaphore = createSemaphore();
            semaphore.release();
            await semaphore.promise;

            assert.throws(() => semaphore.release(), { message: 'Semaphore already released' });
        });

        it('allows multiple waiters on same promise', async () => {
            const semaphore = createSemaphore();
            const resolved = { a: false, b: false, c: false };

            semaphore.promise.then(() => {
                resolved.a = true;
            });
            semaphore.promise.then(() => {
                resolved.b = true;
            });
            semaphore.promise.then(() => {
                resolved.c = true;
            });

            assert.strictEqual(resolved.a, false);
            assert.strictEqual(resolved.b, false);
            assert.strictEqual(resolved.c, false);

            semaphore.release();
            await semaphore.promise;

            assert.strictEqual(resolved.a, true);
            assert.strictEqual(resolved.b, true);
            assert.strictEqual(resolved.c, true);
        });

        it('promise can be awaited after release', async () => {
            const semaphore = createSemaphore();
            semaphore.release();
            await semaphore.promise;
            await semaphore.promise; // Should work multiple times
        });

        it('can be used to coordinate async operations', async () => {
            const semaphore = createSemaphore();
            const order: number[] = [];

            const worker1 = async () => {
                order.push(1);
                await semaphore.promise;
                order.push(2);
            };

            const worker2 = async () => {
                order.push(3);
                await semaphore.promise;
                order.push(4);
            };

            const p1 = worker1();
            const p2 = worker2();

            await new Promise(resolve => setTimeout(resolve, 10));
            assert.deepStrictEqual(order, [1, 3]);

            semaphore.release();
            await Promise.all([p1, p2]);
            assert.deepStrictEqual(order, [1, 3, 2, 4]);
        });

        it('resolves on next tick after release', async () => {
            const semaphore = createSemaphore();
            let resolved = false;

            semaphore.promise.then(() => {
                resolved = true;
            });

            semaphore.release();
            assert.strictEqual(resolved, false); // Not yet resolved synchronously

            await new Promise(resolve => process.nextTick(resolve));
            assert.strictEqual(resolved, true);
        });
    });
});
