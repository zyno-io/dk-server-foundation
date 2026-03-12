import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { createSemaphore, sleepSecs } from '../../src';
import { createTestingFacadeWithDatabase, forEachAdapter } from '../shared/db';

describe('database locks', () => {
    // MySQL-only: the _locks table error test doesn't apply to PG (which uses advisory locks)
    describe('MySQL: without enabling locks table auto-creation', () => {
        let tf: ReturnType<typeof createTestingFacadeWithDatabase>;
        before(
            async () => {
                tf = createTestingFacadeWithDatabase({ entities: [] });
                await tf.start();
            },
            { timeout: 10_000 }
        );
        after(() => tf.stop(), { timeout: 10_000 });

        it('fails to acquire a session lock when the table is missing', { timeout: 10_000 }, async () => {
            const db = tf.getDb();
            await assert.rejects(
                db.transaction(async txn => {
                    await txn.acquireSessionLock('test');
                }),
                /_locks/
            );
        });
    });

    forEachAdapter(({ type, createFacade }) => {
        describe('lock acquisition', () => {
            let tf: ReturnType<typeof createFacade>;
            before(
                async () => {
                    tf = createFacade({
                        entities: [],
                        mysqlConfig: { enableLocksTable: true, connectionLimit: 10 },
                        pgConfig: { max: 10 }
                    });
                    await tf.start();
                },
                { timeout: 10_000 }
            );
            after(() => tf.stop(), { timeout: 10_000 });

            it('should properly lock and unlock', { timeout: 30_000 }, async () => {
                const db = tf.getDb();

                const results: string[] = [];

                const semaphoreA = createSemaphore();
                const promiseA = db.transaction(async txn => {
                    results.push('a start');
                    await db.rawQuery('SELECT 1', txn);
                    await txn.acquireSessionLock('test');
                    results.push('a locked');
                    await db.rawQuery('SELECT 2', txn);
                    results.push('a ready to sleep');
                    semaphoreA.release();
                    await sleepSecs(1);
                    results.push('a wake up');
                });

                // ensure A has a chance to lock before B
                await semaphoreA.promise;

                const semaphoreB = createSemaphore();
                const promiseB = db.transaction(async txn => {
                    results.push('b start');
                    await db.rawQuery('SELECT 1', txn);
                    await txn.acquireSessionLock('test');
                    results.push('b locked');
                    await db.rawQuery('SELECT 2', txn);
                    results.push('b ready to sleep');
                    semaphoreB.release();
                    await sleepSecs(1);
                    results.push('b wake up');
                    if (type === 'mysql') {
                        throw new Error('Ensure failing transactions release locks too');
                    }
                });

                // ensure B has a chance to lock before C
                await semaphoreB.promise;

                const promiseC = db.transaction(async txn => {
                    results.push('c start');
                    await db.rawQuery('SELECT 1', txn);
                    await txn.acquireSessionLock('test');
                    results.push('c locked');
                    await db.rawQuery('SELECT 2', txn);
                });

                const promiseD = db.transaction(async txn => {
                    results.push('d start');
                    await db.rawQuery('SELECT 1', txn);
                    await txn.acquireSessionLock('test');
                    results.push('d locked');
                    await db.rawQuery('SELECT 2', txn);
                });

                const [resultA, resultB, resultC, resultD] = await Promise.allSettled([promiseA, promiseB, promiseC, promiseD]);

                assert.strictEqual(resultA.status, 'fulfilled');
                if (type === 'mysql') {
                    assert.strictEqual(resultB.status, 'rejected');
                } else {
                    assert.strictEqual(resultB.status, 'fulfilled');
                }
                assert.strictEqual(resultC.status, 'fulfilled');
                assert.strictEqual(resultD.status, 'fulfilled');

                // All adapters must serialize: A locks before B, B before C/D
                assert.ok(results.indexOf('a locked') < results.indexOf('b locked'));
                assert.ok(results.indexOf('b locked') < results.indexOf('c locked'));
                assert.ok(results.indexOf('b locked') < results.indexOf('d locked'));

                if (type === 'mysql') {
                    // Check the deterministic portion of the results
                    assert.deepStrictEqual(results.slice(0, 10), [
                        'a start',
                        'a locked',
                        'a ready to sleep',
                        'b start',
                        'a wake up',
                        'b locked',
                        'b ready to sleep',
                        'c start',
                        'd start',
                        'b wake up'
                    ]);

                    // The last two entries are "c locked" and "d locked" in either order
                    assert.strictEqual(results.length, 12);
                    assert.match(results[10], /[cd] locked/);
                    assert.match(results[11], /[cd] locked/);
                }
            });
        });
    });
});
