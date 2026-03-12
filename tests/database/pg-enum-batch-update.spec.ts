import { ActiveRecord, DatabaseSession, DatabaseAdapter } from '@deepkit/orm';
import { AutoIncrement, entity, PrimaryKey } from '@deepkit/type';
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { createPersistedEntity } from '../../src';
import { createTestingFacadeWithDatabase } from '../shared/db';

/**
 * Tests that Deepkit's PostgresPersistence.batchUpdate works correctly
 * with PostgreSQL enum column types. Without the @deepkit/postgres patch,
 * the CASE expression in the CTE fails because the VALUES entries are
 * cast as ::text while the original table column is the enum type.
 */

enum TestStatus {
    pending = 'pending',
    active = 'active',
    failed = 'failed'
}

@entity.name('test_enum_bu')
class TestEnumEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
    status!: TestStatus;
}

// String literal union — also gets a PG enum type via the migration system
type TestPriority = 'low' | 'medium' | 'high';

@entity.name('test_union_bu')
class TestUnionEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    label!: string;
    priority!: TestPriority;
}

// Nullable enum
@entity.name('test_nullable_enum_bu')
class TestNullableEnumEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    label!: string;
    status!: TestStatus | null;
}

describe('PostgreSQL enum batchUpdate (@deepkit/postgres patch)', () => {
    describe('TypeScript enum column', () => {
        const tf = createTestingFacadeWithDatabase({ dbType: 'postgres', entities: [TestEnumEntity] });

        before(
            async () => {
                await tf.start();
                await tf.createTables();

                // Convert Deepkit's text column to a real PG enum type.
                // This matches what the project's migration system produces.
                const db = tf.getDb();
                await db.rawExecute("CREATE TYPE \"test_enum_bu_status\" AS ENUM ('pending', 'active', 'failed')");
                await db.rawExecute(
                    'ALTER TABLE "test_enum_bu" ALTER COLUMN "status" TYPE "test_enum_bu_status" USING "status"::"test_enum_bu_status"'
                );
            },
            { timeout: 15_000 }
        );

        after(() => tf.stop(), { timeout: 10_000 });

        it('should update a single entity via save()', async () => {
            const ent = await createPersistedEntity(TestEnumEntity, {
                name: 'test1',
                status: TestStatus.pending
            });

            const retrieved = await TestEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(retrieved.status, 'pending');

            retrieved.status = TestStatus.failed;
            await retrieved.save();

            const updated = await TestEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(updated.status, 'failed');
        });

        it('should batch-update multiple entities via transaction', async () => {
            const ent1 = await createPersistedEntity(TestEnumEntity, { name: 'batch1', status: TestStatus.pending });
            const ent2 = await createPersistedEntity(TestEnumEntity, { name: 'batch2', status: TestStatus.active });

            await tf.getDb().transaction(async (txn: DatabaseSession<DatabaseAdapter>) => {
                const items = await txn
                    .query(TestEnumEntity)
                    .filter({ id: { $in: [ent1.id, ent2.id] } })
                    .find();
                items[0].status = TestStatus.active;
                items[1].status = TestStatus.failed;
                txn.add(items[0]);
                txn.add(items[1]);
            });

            const [r1, r2] = await TestEnumEntity.query()
                .filter({ id: { $in: [ent1.id, ent2.id] } })
                .orderBy('id')
                .find();
            assert.strictEqual(r1.status, 'active');
            assert.strictEqual(r2.status, 'failed');
        });

        it('should update enum alongside other fields', async () => {
            const ent = await createPersistedEntity(TestEnumEntity, {
                name: 'original',
                status: TestStatus.pending
            });

            const retrieved = await TestEnumEntity.query().filter({ id: ent.id }).findOne();
            retrieved.name = 'updated';
            retrieved.status = TestStatus.active;
            await retrieved.save();

            const updated = await TestEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(updated.name, 'updated');
            assert.strictEqual(updated.status, 'active');
        });
    });

    describe('string literal union column', () => {
        const tf = createTestingFacadeWithDatabase({ dbType: 'postgres', entities: [TestUnionEntity] });

        before(
            async () => {
                await tf.start();
                await tf.createTables();

                const db = tf.getDb();
                await db.rawExecute("CREATE TYPE \"test_union_bu_priority\" AS ENUM ('low', 'medium', 'high')");
                await db.rawExecute(
                    'ALTER TABLE "test_union_bu" ALTER COLUMN "priority" TYPE "test_union_bu_priority" USING "priority"::"test_union_bu_priority"'
                );
            },
            { timeout: 15_000 }
        );

        after(() => tf.stop(), { timeout: 10_000 });

        it('should update a string literal union column via save()', async () => {
            const ent = await createPersistedEntity(TestUnionEntity, {
                label: 'task1',
                priority: 'low'
            });

            const retrieved = await TestUnionEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(retrieved.priority, 'low');

            retrieved.priority = 'high';
            await retrieved.save();

            const updated = await TestUnionEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(updated.priority, 'high');
        });
    });

    describe('nullable enum column', () => {
        const tf = createTestingFacadeWithDatabase({ dbType: 'postgres', entities: [TestNullableEnumEntity] });

        before(
            async () => {
                await tf.start();
                await tf.createTables();

                const db = tf.getDb();
                await db.rawExecute("CREATE TYPE \"test_nullable_enum_bu_status\" AS ENUM ('pending', 'active', 'failed')");
                await db.rawExecute(
                    'ALTER TABLE "test_nullable_enum_bu" ALTER COLUMN "status" TYPE "test_nullable_enum_bu_status" USING "status"::"test_nullable_enum_bu_status"'
                );
            },
            { timeout: 15_000 }
        );

        after(() => tf.stop(), { timeout: 10_000 });

        it('should update nullable enum from value to different value', async () => {
            const ent = await createPersistedEntity(TestNullableEnumEntity, {
                label: 'nullable1',
                status: TestStatus.pending
            });

            const retrieved = await TestNullableEnumEntity.query().filter({ id: ent.id }).findOne();
            retrieved.status = TestStatus.failed;
            await retrieved.save();

            const updated = await TestNullableEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(updated.status, 'failed');
        });

        it('should update nullable enum from value to null', async () => {
            const ent = await createPersistedEntity(TestNullableEnumEntity, {
                label: 'nullable2',
                status: TestStatus.active
            });

            const retrieved = await TestNullableEnumEntity.query().filter({ id: ent.id }).findOne();
            retrieved.status = null;
            await retrieved.save();

            const updated = await TestNullableEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(updated.status, null);
        });

        it('should update nullable enum from null to value', async () => {
            const ent = await createPersistedEntity(TestNullableEnumEntity, {
                label: 'nullable3',
                status: null
            });

            const retrieved = await TestNullableEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(retrieved.status, null);

            retrieved.status = TestStatus.active;
            await retrieved.save();

            const updated = await TestNullableEnumEntity.query().filter({ id: ent.id }).findOne();
            assert.strictEqual(updated.status, 'active');
        });
    });
});
