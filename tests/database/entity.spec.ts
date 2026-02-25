import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ActiveRecord, DatabaseAdapter, DatabaseEntityRegistry, DatabaseSession } from '@deepkit/orm';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { AutoIncrement, entity, MySQL, PrimaryKey, UUID } from '@deepkit/type';

import { ApiName, createPersistedEntity, getEntityFields, MySQLCoordinate, NullableMySQLCoordinate, UuidString } from '../../src';
import {
    getDirtyDetails,
    getEntityOriginal,
    getFieldOriginal,
    resolveRelated,
    resolveRelatedByPivot,
    resolveRelatedByPivotForOne,
    revertDirtyEntity
} from '../../src/database/entity';
import { createTestingFacadeWithDatabase, forEachAdapter } from '../shared/db';
import { assertMatchObject } from '../shared/helpers';

it.skip('ensures "belongs to" types are correct', async () => {
    class RootEntity extends ActiveRecord {
        id!: number & PrimaryKey;
        relatedEntityId!: number | null;
    }

    class RelatedEntity extends ActiveRecord {
        id!: number & PrimaryKey;
        sampleField!: string;
    }

    const entities: RootEntity[] = [];
    const resolved = await resolveRelated({
        src: entities,
        srcIdField: 'relatedEntityId',
        targetField: 'relatedEntity',
        targetSchema: RelatedEntity
    });

    // eslint-disable-next-line unused-imports/no-unused-vars
    type T1 = NonNullable<(typeof resolved)[0]['relatedEntity']>['sampleField']; // should be string

    assert.notStrictEqual(resolved, undefined);
});

it.skip('ensures pivot types are correct', async () => {
    class RootEntity extends ActiveRecord {
        id!: number & PrimaryKey;
    }

    class PivotEntity extends ActiveRecord {
        id!: number & PrimaryKey;
        rootEntityId!: number;
        relatedEntityId!: number;
    }

    class RelatedEntity extends ActiveRecord {
        id!: number & PrimaryKey;
        sampleField!: string;
    }

    const entities: RootEntity[] = [];
    const resolved = await resolveRelatedByPivot({
        src: entities,
        pivotSchema: PivotEntity,
        pivotIdKey: 'rootEntityId',
        pivotRelatedKey: 'relatedEntityId',
        targetSchema: RelatedEntity,
        targetField: 'relatedEntities'
    });

    // eslint-disable-next-line unused-imports/no-unused-vars
    type T1 = (typeof resolved)[0]['relatedEntities'][0]['sampleField']; // should be string
    // eslint-disable-next-line unused-imports/no-unused-vars
    type T2 = (typeof resolved)[0]['relatedEntities'][0]['pivot']['id']; // should be number & PrimaryKey

    const _resolvedOne = await resolveRelatedByPivotForOne({
        src: entities[0],
        pivotSchema: PivotEntity,
        pivotIdKey: 'rootEntityId',
        pivotRelatedKey: 'relatedEntityId',
        targetSchema: RelatedEntity,
        targetField: 'relatedEntities'
    });

    // eslint-disable-next-line unused-imports/no-unused-vars
    type T3 = (typeof _resolvedOne)['relatedEntities'][0]['sampleField']; // should be string

    assert.notStrictEqual(resolved, undefined);
});

// Shared entity — no DB-specific type annotations so it works on both MySQL and PG
@entity.name('test1')
class Test1Entity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
    city!: string;
    state!: string;
    favoriteColor!: string | null;
}

describe('entity operations', () => {
    forEachAdapter(({ createFacade }) => {
        const tf = createFacade({ entities: [Test1Entity] });
        before(
            async () => {
                await tf.start();
                await tf.createTables();
            },
            { timeout: 10_000 }
        );
        after(() => tf.stop(), { timeout: 10_000 });

        it('should insert and retrieve entities', async () => {
            await createPersistedEntity(Test1Entity, {
                name: 'Fred',
                city: 'New York',
                state: 'NY'
            });
            const retrieved = await Test1Entity.query().orderBy('id', 'desc').findOne();
            assert.strictEqual(retrieved.name, 'Fred');
        });

        it('should handle dirty operations properly', async () => {
            await createPersistedEntity(Test1Entity, {
                name: 'Bob',
                city: 'Los Angeles',
                state: 'CA',
                favoriteColor: 'blue'
            });
            const retrieved = await Test1Entity.query().orderBy('id', 'desc').findOne();
            retrieved.favoriteColor = 'red';

            // silly test but makes us feel better about the rest of the tests, especially revert
            assertMatchObject(retrieved, {
                favoriteColor: 'red'
            });

            const changes = getDirtyDetails(retrieved);
            assertMatchObject(changes, {
                favoriteColor: {
                    original: 'blue',
                    current: 'red'
                }
            });

            const originalValue = getFieldOriginal(retrieved, 'favoriteColor');
            assert.strictEqual(originalValue, 'blue');

            const originalEntity = getEntityOriginal(retrieved);
            assertMatchObject(originalEntity, {
                favoriteColor: 'blue'
            });

            const currentEntity = getEntityFields(retrieved);
            assertMatchObject(currentEntity, {
                favoriteColor: 'red'
            });

            revertDirtyEntity(retrieved);
            assertMatchObject(retrieved, {
                favoriteColor: 'blue'
            });
        });

        it('should not persist things I did not explicitly ask it to', async () => {
            const { id: id1 } = await createPersistedEntity(Test1Entity, {
                name: 'Tom',
                city: 'Dallas',
                state: 'TX',
                favoriteColor: 'green'
            });
            const { id: id2 } = await createPersistedEntity(Test1Entity, {
                name: 'Jim',
                city: 'Houston',
                state: 'TX',
                favoriteColor: 'orange'
            });

            const ids = [id1, id2];

            await tf.app.get(tf.DB).transaction(async (txn: DatabaseSession<DatabaseAdapter>) => {
                const entities = await txn
                    .query(Test1Entity)
                    .filter({ id: { $in: ids } })
                    .orderBy('id')
                    .find();
                entities[0].favoriteColor = 'purple';
                entities[1].favoriteColor = 'yellow';
                txn.add(entities[1]);
            });

            const retrieved = await Test1Entity.query()
                .filter({ id: { $in: ids } })
                .orderBy('id')
                .find();
            assert.strictEqual(retrieved[0].favoriteColor, 'green');
            assert.strictEqual(retrieved[1].favoriteColor, 'yellow');
        });

        it('dk patch: can update and delete entities', async () => {
            const ent = await createPersistedEntity(Test1Entity, {
                name: 'Fred',
                city: 'New York',
                state: 'NY'
            });

            await tf.getDb().transaction(async txn => {
                {
                    const result = await txn.query(Test1Entity).filter({ id: ent.id }).patchMany({ name: 'George' });
                    assert.deepStrictEqual(result.primaryKeys[0], { id: ent.id });
                }

                {
                    const result = await txn.query(Test1Entity).filter({ id: 999999 }).patchMany({ name: 'George' });
                    assert.strictEqual(result.primaryKeys[0], undefined);
                }

                {
                    const result = await txn.query(Test1Entity).filter({ id: ent.id }).deleteMany();
                    assert.deepStrictEqual(result.primaryKeys[0], { id: ent.id });
                }

                {
                    const result = await txn.query(Test1Entity).filter({ id: ent.id }).deleteMany();
                    assert.strictEqual(result.primaryKeys[0], undefined); // second time deleting, it won't exist, so should not get a PK back
                }
            });
        });
    });
});

describe('MySQLCoordinate / POINT column', () => {
    @entity.name('test2')
    class Test2Entity extends ActiveRecord {
        id!: number & AutoIncrement & PrimaryKey & MySQL<{ type: 'int' }>;
        name!: string;
        // Plain coordinate types
        location!: MySQLCoordinate;
        nullableLocation!: NullableMySQLCoordinate;
        // Coordinate types with ApiName (intersection with type annotation)
        locationWithApiName!: MySQLCoordinate & ApiName<'location_alt_name'>;
        nullableLocationWithApiName!: NullableMySQLCoordinate & ApiName<'nullable_location'>;
    }

    const tf = createTestingFacadeWithDatabase({ entities: [Test2Entity] });
    before(
        async () => {
            await tf.start();

            const adapter = tf.getDb().adapter as SQLDatabaseAdapter;

            // create table in memory and validate types
            const [testTable] = adapter.platform.createTables(DatabaseEntityRegistry.from([Test2Entity]));

            // Plain coordinate types
            assert.strictEqual(testTable.getColumn('location').type, 'point');
            assert.strictEqual(testTable.getColumn('nullableLocation').type, 'point');
            // Coordinate types with ApiName (intersection with type annotation)
            assert.strictEqual(testTable.getColumn('locationWithApiName').type, 'point');
            assert.strictEqual(testTable.getColumn('nullableLocationWithApiName').type, 'point');

            // create table for real
            tf.getDb().registerEntity(Test2Entity);
            await tf.createTables();
        },
        { timeout: 10_000 }
    );
    after(() => tf.stop(), { timeout: 10_000 });

    it('should insert and retrieve entities with coordinates', async () => {
        const entity = await createPersistedEntity(Test2Entity, {
            name: 'Fred',
            location: { x: 1, y: 2 },
            nullableLocation: { x: 10, y: 20 },
            locationWithApiName: { x: 100, y: 200 },
            nullableLocationWithApiName: { x: 1000, y: 2000 }
        });

        const retrieved = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assertMatchObject(retrieved.location, { x: 1, y: 2 });
        assertMatchObject(retrieved.nullableLocation!, { x: 10, y: 20 });
        assertMatchObject(retrieved.locationWithApiName, { x: 100, y: 200 });
        assertMatchObject(retrieved.nullableLocationWithApiName!, { x: 1000, y: 2000 });
    });

    it('should update coordinates and persist the change', async () => {
        const entity = await createPersistedEntity(Test2Entity, {
            name: 'Bob',
            location: { x: 1, y: 2 },
            nullableLocation: { x: 10, y: 20 },
            locationWithApiName: { x: 100, y: 200 },
            nullableLocationWithApiName: { x: 1000, y: 2000 }
        });

        const retrieved = await Test2Entity.query().filter({ id: entity.id }).findOne();
        retrieved.location = { x: 3, y: 4 };
        retrieved.nullableLocation = { x: 30, y: 40 };
        retrieved.locationWithApiName = { x: 300, y: 400 };
        retrieved.nullableLocationWithApiName = { x: 3000, y: 4000 };
        await retrieved.save();

        // re-retrieve to verify persistence
        const updated = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assertMatchObject(updated.location, { x: 3, y: 4 });
        assertMatchObject(updated.nullableLocation!, { x: 30, y: 40 });
        assertMatchObject(updated.locationWithApiName, { x: 300, y: 400 });
        assertMatchObject(updated.nullableLocationWithApiName!, { x: 3000, y: 4000 });
    });

    it('should handle null coordinates', async () => {
        const entity = await createPersistedEntity(Test2Entity, {
            name: 'NullTest',
            location: { x: 1, y: 2 },
            nullableLocation: null,
            locationWithApiName: { x: 10, y: 20 },
            nullableLocationWithApiName: null
        });

        const retrieved = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assertMatchObject(retrieved.location, { x: 1, y: 2 });
        assert.strictEqual(retrieved.nullableLocation, null);
        assertMatchObject(retrieved.locationWithApiName, { x: 10, y: 20 });
        assert.strictEqual(retrieved.nullableLocationWithApiName, null);
    });

    it('should update nullable coordinates to null', async () => {
        const entity = await createPersistedEntity(Test2Entity, {
            name: 'NullUpdateTest',
            location: { x: 5, y: 6 },
            nullableLocation: { x: 50, y: 60 },
            locationWithApiName: { x: 500, y: 600 },
            nullableLocationWithApiName: { x: 5000, y: 6000 }
        });

        const retrieved = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assertMatchObject(retrieved.nullableLocation!, { x: 50, y: 60 });
        assertMatchObject(retrieved.nullableLocationWithApiName!, { x: 5000, y: 6000 });

        retrieved.nullableLocation = null;
        retrieved.nullableLocationWithApiName = null;
        await retrieved.save();

        const updated = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assert.strictEqual(updated.nullableLocation, null);
        assert.strictEqual(updated.nullableLocationWithApiName, null);
        // Non-nullable fields remain unchanged
        assertMatchObject(updated.location, { x: 5, y: 6 });
        assertMatchObject(updated.locationWithApiName, { x: 500, y: 600 });
    });

    it('should handle negative and decimal coordinates', async () => {
        const entity = await createPersistedEntity(Test2Entity, {
            name: 'DecimalTest',
            location: { x: -122.4194, y: 37.7749 }, // San Francisco coordinates
            nullableLocation: { x: 0.0, y: 0.0 },
            locationWithApiName: { x: -73.9857, y: 40.7484 }, // New York coordinates
            nullableLocationWithApiName: { x: -0.1276, y: 51.5074 } // London coordinates
        });

        const retrieved = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assertMatchObject(retrieved.location, { x: -122.4194, y: 37.7749 });
        assertMatchObject(retrieved.nullableLocation!, { x: 0, y: 0 });
        assertMatchObject(retrieved.locationWithApiName, { x: -73.9857, y: 40.7484 });
        assertMatchObject(retrieved.nullableLocationWithApiName!, { x: -0.1276, y: 51.5074 });
    });

    it('should handle very large coordinates', async () => {
        const entity = await createPersistedEntity(Test2Entity, {
            name: 'LargeTest',
            location: { x: 180, y: -90 }, // Max longitude/latitude
            nullableLocation: { x: -180, y: 90 },
            locationWithApiName: { x: 179.9999, y: -89.9999 },
            nullableLocationWithApiName: { x: -179.9999, y: 89.9999 }
        });

        const retrieved = await Test2Entity.query().filter({ id: entity.id }).findOne();
        assertMatchObject(retrieved.location, { x: 180, y: -90 });
        assertMatchObject(retrieved.nullableLocation!, { x: -180, y: 90 });
        assertMatchObject(retrieved.locationWithApiName, { x: 179.9999, y: -89.9999 });
        assertMatchObject(retrieved.nullableLocationWithApiName!, { x: -179.9999, y: 89.9999 });
    });
});

// --- UUID round-trip tests ---

@entity.name('test_uuid_string')
class TestUuidStringEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    token!: UuidString;
}

describe('UuidString round-trip', () => {
    forEachAdapter(({ createFacade }) => {
        const tf = createFacade({ entities: [TestUuidStringEntity] });
        before(
            async () => {
                await tf.start();
                await tf.createTables();
            },
            { timeout: 10_000 }
        );
        after(() => tf.stop(), { timeout: 10_000 });

        it('should insert and retrieve UuidString as a plain string', async () => {
            const uuidValue = '550e8400-e29b-41d4-a716-446655440000';
            const created = await createPersistedEntity(TestUuidStringEntity, { token: uuidValue as UuidString });
            const retrieved = await TestUuidStringEntity.query().filter({ id: created.id }).findOne();
            assert.strictEqual(retrieved.token, uuidValue);
        });
    });
});

@entity.name('test_uuid_builtin')
class TestUuidBuiltinEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    externalId!: UUID;
}

describe('Deepkit UUID round-trip', () => {
    forEachAdapter(({ createFacade }) => {
        const tf = createFacade({ entities: [TestUuidBuiltinEntity] });
        before(
            async () => {
                await tf.start();
                await tf.createTables();
            },
            { timeout: 10_000 }
        );
        after(() => tf.stop(), { timeout: 10_000 });

        it('should insert and retrieve UUID as a plain string', async () => {
            const uuidValue = '550e8400-e29b-41d4-a716-446655440000' as UUID;
            const created = await createPersistedEntity(TestUuidBuiltinEntity, { externalId: uuidValue });
            const retrieved = await TestUuidBuiltinEntity.query().filter({ id: created.id }).findOne();
            assert.strictEqual(retrieved.externalId, uuidValue);
        });
    });
});
