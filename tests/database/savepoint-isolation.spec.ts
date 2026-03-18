import { ActiveRecord } from '@deepkit/orm';
import { AutoIncrement, entity, PrimaryKey } from '@deepkit/type';
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { mock } from 'node:test';

import { createPersistedEntity } from '../../src';
import { forEachAdapter } from '../shared/db';

@entity.name('sp_item')
class ItemEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
    value!: number;
}

describe('savepoint isolation', () => {
    forEachAdapter(({ createFacade }) => {
        describe('basic isolation', () => {
            const tf = createFacade({
                entities: [ItemEntity],
                async seedData() {
                    await createPersistedEntity(ItemEntity, { name: 'seed-item', value: 100 });
                }
            });

            before(
                async () => {
                    await tf.start();
                    await tf.createTables();
                },
                { timeout: 15_000 }
            );
            after(() => tf.stop(), { timeout: 10_000 });
            beforeEach(() => tf.resetToSeed());
            afterEach(() => {
                mock.timers.reset();
                mock.restoreAll();
            });

            it('should have seed data available', async () => {
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed-item');
                assert.strictEqual(items[0].value, 100);
            });

            it('should isolate inserts between tests', async () => {
                const before = await ItemEntity.query().find();
                assert.strictEqual(before.length, 1);

                await createPersistedEntity(ItemEntity, { name: 'test-only', value: 999 });
                const after = await ItemEntity.query().find();
                assert.strictEqual(after.length, 2);
            });

            it('should not see data from the previous test', async () => {
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed-item');
            });

            it('should isolate updates between tests', async () => {
                const item = await ItemEntity.query().filter({ name: 'seed-item' }).findOne();
                await ItemEntity.query().filter({ id: item.id }).patchOne({ value: 999 });

                const updated = await ItemEntity.query().filter({ id: item.id }).findOne();
                assert.strictEqual(updated.value, 999);
            });

            it('should not see updates from the previous test', async () => {
                const item = await ItemEntity.query().filter({ name: 'seed-item' }).findOne();
                assert.strictEqual(item.value, 100);
            });

            it('should isolate deletes between tests', async () => {
                await ItemEntity.query().filter({ name: 'seed-item' }).deleteMany();
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 0);
            });

            it('should restore deleted data on rollback', async () => {
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed-item');
            });

            it('should confirm savepoint isolation is active', async () => {
                assert.strictEqual(tf.savepointIsolationActive, true);
            });
        });

        describe('app-level transactions within savepoint isolation', () => {
            const tf = createFacade({
                entities: [ItemEntity],
                async seedData() {
                    await createPersistedEntity(ItemEntity, { name: 'seed', value: 1 });
                }
            });

            before(
                async () => {
                    await tf.start();
                    await tf.createTables();
                },
                { timeout: 15_000 }
            );
            after(() => tf.stop(), { timeout: 10_000 });
            beforeEach(() => tf.resetToSeed());
            afterEach(() => {
                mock.timers.reset();
                mock.restoreAll();
            });

            it('should support committed transactions', async () => {
                const db = tf.getDb();

                await db.transaction(async txn => {
                    await createPersistedEntity(ItemEntity, { name: 'txn-item', value: 42 }, txn);
                });

                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 2);
                assert.ok(items.find(i => i.name === 'txn-item'));
            });

            it('should not see committed txn data from previous test', async () => {
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed');
            });

            it('should support rolled-back transactions', async () => {
                const db = tf.getDb();

                await assert.rejects(
                    db.transaction(async txn => {
                        await createPersistedEntity(ItemEntity, { name: 'will-rollback', value: 0 }, txn);
                        throw new Error('intentional rollback');
                    }),
                    /intentional rollback/
                );

                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed');
            });
        });

        describe('opt-out with useSavepoints: false', () => {
            const tf = createFacade({
                entities: [ItemEntity],
                useSavepoints: false,
                async seedData() {
                    await createPersistedEntity(ItemEntity, { name: 'seed', value: 1 });
                }
            });

            before(
                async () => {
                    await tf.start();
                    await tf.createTables();
                },
                { timeout: 15_000 }
            );
            after(() => tf.stop(), { timeout: 10_000 });
            beforeEach(() => tf.resetToSeed());
            afterEach(() => {
                mock.timers.reset();
                mock.restoreAll();
            });

            it('should not use savepoint isolation when opted out', async () => {
                assert.strictEqual(tf.savepointIsolationActive, false);
            });

            it('should still have seed data via truncate+reseed', async () => {
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed');
            });

            it('should still isolate data between tests via truncate+reseed', async () => {
                await createPersistedEntity(ItemEntity, { name: 'extra', value: 2 });
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 2);
            });

            it('should not see data from previous test after truncate+reseed', async () => {
                const items = await ItemEntity.query().find();
                assert.strictEqual(items.length, 1);
                assert.strictEqual(items[0].name, 'seed');
            });
        });
    });
});
