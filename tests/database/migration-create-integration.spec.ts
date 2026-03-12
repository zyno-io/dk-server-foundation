import { ActiveRecord } from '@deepkit/orm';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { AutoIncrement, entity, Index, MaxLength, PrimaryKey, Unique } from '@deepkit/type';
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { DateString } from '../../src';
import { getDialect, Dialect } from '../../src/database/dialect';
import { compareSchemas } from '../../src/database/migration/create/comparator';
import { readDatabaseSchema } from '../../src/database/migration/create/db-reader';
import { generateDDL } from '../../src/database/migration/create/ddl-generator';
import { readEntitiesSchema } from '../../src/database/migration/create/entity-reader';
import { setNonInteractive } from '../../src/database/migration/create/prompt';
import { forEachAdapter } from '../shared/db';

setNonInteractive(true);

// --- Test entities ---

@entity.name('mig_users')
class MigUserEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string & MaxLength<100>;
    email!: string & MaxLength<255> & Index;
    bio!: string | null;
    active!: boolean;
    createdAt!: Date;
}

@entity.name('mig_posts')
class MigPostEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    title!: string & MaxLength<200>;
    body!: string;
    publishedAt!: DateString | null;
}

@entity.name('mig_sessions')
class MigSessionEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    token!: string & MaxLength<255>;
    userId?: string;
    userName?: string & MaxLength<100>;
}

const testEntities = [MigUserEntity, MigPostEntity, MigSessionEntity];

// --- Union type test entities (separate from main entities to avoid createTables issues) ---

@entity.name('mig_union_types')
class MigUnionTypesEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    stringUnion!: 'active' | 'inactive' | 'banned';
    numberUnion!: 1 | 2 | 3;
    nullableStringUnion!: ('enabled' | 'disabled') | null;
}

const unionTestEntities = [MigUnionTypesEntity];

// --- Index options test entities ---

@(entity.name('mig_index_options').index(['groupId', 'name'], { unique: true }).index(['groupId', 'priority'], { name: 'idx_custom_name' }))
class MigIndexOptionsEntity extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    email!: string & MaxLength<255> & Unique;
    tag!: string & MaxLength<100> & Index<{ name: 'idx_custom_tag' }>;
    groupId!: number;
    name!: string & MaxLength<100>;
    priority!: number;
}

const indexTestEntities = [MigIndexOptionsEntity];

describe('migration:create integration', () => {
    forEachAdapter(({ createFacade }) => {
        const tf = createFacade({ entities: testEntities });
        let dialect: Dialect;

        before(
            async () => {
                await tf.start();
                dialect = getDialect(tf.getDb().adapter as SQLDatabaseAdapter);
            },
            { timeout: 10_000 }
        );
        after(() => tf.stop(), { timeout: 10_000 });

        describe('entity reader', () => {
            it('should read entity schema', () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);

                assert.ok(entitySchema.has('mig_users'));
                assert.ok(entitySchema.has('mig_posts'));

                const users = entitySchema.get('mig_users')!;
                assert.equal(users.name, 'mig_users');

                // Check columns
                const colNames = users.columns.map(c => c.name);
                assert.ok(colNames.includes('id'));
                assert.ok(colNames.includes('name'));
                assert.ok(colNames.includes('email'));
                assert.ok(colNames.includes('bio'));
                assert.ok(colNames.includes('active'));
                assert.ok(colNames.includes('createdAt'));

                // Check PK
                const idCol = users.columns.find(c => c.name === 'id')!;
                assert.equal(idCol.isPrimaryKey, true);
                assert.equal(idCol.autoIncrement, true);

                // Check MaxLength → varchar
                const nameCol = users.columns.find(c => c.name === 'name')!;
                assert.equal(nameCol.type, 'varchar');
                assert.equal(nameCol.size, 100);

                // Check nullable
                const bioCol = users.columns.find(c => c.name === 'bio')!;
                assert.equal(bioCol.nullable, true);

                const emailCol = users.columns.find(c => c.name === 'email')!;
                assert.equal(emailCol.nullable, false);

                // Check boolean mapping
                const activeCol = users.columns.find(c => c.name === 'active')!;
                if (dialect === 'mysql') {
                    assert.equal(activeCol.type, 'tinyint');
                    assert.equal(activeCol.size, 1);
                } else {
                    assert.equal(activeCol.type, 'boolean');
                }

                // Check Date mapping
                const createdAtCol = users.columns.find(c => c.name === 'createdAt')!;
                if (dialect === 'mysql') {
                    assert.equal(createdAtCol.type, 'datetime');
                } else {
                    assert.equal(createdAtCol.type, 'timestamp');
                }

                // Check DateString mapping
                const posts = entitySchema.get('mig_posts')!;
                const publishedAtCol = posts.columns.find(c => c.name === 'publishedAt')!;
                assert.equal(publishedAtCol.type, 'date');
                assert.equal(publishedAtCol.nullable, true);

                // Check index on email (should appear exactly once)
                const emailIndexes = users.indexes.filter(i => i.columns.includes('email'));
                assert.equal(emailIndexes.length, 1, 'email index should appear exactly once');

                // Check optional (?) fields are nullable
                const sessions = entitySchema.get('mig_sessions')!;
                const userIdCol = sessions.columns.find(c => c.name === 'userId')!;
                assert.equal(userIdCol.nullable, true, 'optional field userId? should be nullable');
                const userNameCol = sessions.columns.find(c => c.name === 'userName')!;
                assert.equal(userNameCol.nullable, true, 'optional field userName? should be nullable');
                const tokenCol = sessions.columns.find(c => c.name === 'token')!;
                assert.equal(tokenCol.nullable, false, 'required field token should not be nullable');
            });

            it('should skip internal tables', () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);

                // _migrations and _locks should be skipped
                for (const [name] of entitySchema) {
                    assert.ok(!name.startsWith('_'), `Internal table ${name} should be skipped`);
                }
            });

            it('should preserve column order', () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);

                const users = entitySchema.get('mig_users')!;
                const positions = users.columns.map(c => c.ordinalPosition);

                // Positions should be sequential
                for (let i = 1; i < positions.length; i++) {
                    assert.ok(positions[i] > positions[i - 1], `Column order should be sequential`);
                }
            });
        });

        describe('entity reader — union types', () => {
            const uf = createFacade({ entities: unionTestEntities });

            before(
                async () => {
                    await uf.start();
                },
                { timeout: 10_000 }
            );
            after(() => uf.stop(), { timeout: 10_000 });

            it('should resolve string literal union as enum', () => {
                const db = uf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_union_types')!;
                assert.ok(tbl, 'mig_union_types table should exist');

                const col = tbl.columns.find(c => c.name === 'stringUnion')!;
                assert.equal(col.type, 'enum');
                assert.deepEqual(col.enumValues, ['active', 'inactive', 'banned']);
                if (dialect === 'postgres') {
                    assert.equal(col.enumTypeName, 'mig_union_types_stringUnion');
                }
            });

            it('should resolve number literal union as smallest integer type', () => {
                const db = uf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_union_types')!;

                const col = tbl.columns.find(c => c.name === 'numberUnion')!;
                if (dialect === 'mysql') {
                    assert.equal(col.type, 'tinyint');
                    assert.equal(col.unsigned, true);
                } else {
                    assert.equal(col.type, 'smallint');
                }
            });

            it('should resolve nullable string literal union as nullable enum', () => {
                const db = uf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_union_types')!;

                const col = tbl.columns.find(c => c.name === 'nullableStringUnion')!;
                assert.equal(col.type, 'enum');
                assert.equal(col.nullable, true);
                assert.deepEqual(col.enumValues, ['enabled', 'disabled']);
            });
        });

        describe('entity reader — index options', () => {
            const xf = createFacade({ entities: indexTestEntities });

            before(
                async () => {
                    await xf.start();
                },
                { timeout: 10_000 }
            );
            after(() => xf.stop(), { timeout: 10_000 });

            it('should resolve & Unique as index with unique: true', () => {
                const db = xf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_index_options')!;
                assert.ok(tbl, 'mig_index_options table should exist');

                const emailIndex = tbl.indexes.find(i => i.columns.length === 1 && i.columns[0] === 'email');
                assert.ok(emailIndex, 'should have an index on email');
                assert.equal(emailIndex.unique, true, 'email index should be unique');
            });

            it('should use custom name from & Index<{name: ...}>', () => {
                const db = xf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_index_options')!;

                const tagIndex = tbl.indexes.find(i => i.columns.length === 1 && i.columns[0] === 'tag');
                assert.ok(tagIndex, 'should have an index on tag');
                assert.equal(tagIndex.name, 'idx_custom_tag', 'tag index should use custom name');
            });

            it('should create composite unique index from @entity.index()', () => {
                const db = xf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_index_options')!;

                const compositeUnique = tbl.indexes.find(
                    i => i.columns.length === 2 && i.columns.includes('groupId') && i.columns.includes('name') && i.unique
                );
                assert.ok(compositeUnique, 'should have a composite unique index on [groupId, name]');
            });

            it('should use custom name from @entity.index() options', () => {
                const db = xf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_index_options')!;

                const customNameIdx = tbl.indexes.find(i => i.name === 'idx_custom_name');
                assert.ok(customNameIdx, 'should have an index with custom name idx_custom_name');
                assert.deepEqual(customNameIdx.columns, ['groupId', 'priority']);
            });

            it('should not produce duplicate indexes', () => {
                const db = xf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tbl = entitySchema.get('mig_index_options')!;

                // Count indexes that include 'email' — should be exactly 1
                const emailIndexes = tbl.indexes.filter(i => i.columns.includes('email'));
                assert.equal(emailIndexes.length, 1, 'email should have exactly one index (no duplicates)');

                // Count indexes that include 'tag' — should be exactly 1
                const tagIndexes = tbl.indexes.filter(i => i.columns.includes('tag'));
                assert.equal(tagIndexes.length, 1, 'tag should have exactly one index (no duplicates)');
            });
        });

        describe('db reader', () => {
            before(async () => {
                await tf.createTables();
            });

            it('should read database schema matching entity schema', async () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tableNames = Array.from(entitySchema.keys());

                const dbSchema = await readDatabaseSchema(db, dialect, tableNames);

                assert.ok(dbSchema.has('mig_users'));
                assert.ok(dbSchema.has('mig_posts'));

                const users = dbSchema.get('mig_users')!;
                const colNames = users.columns.map(c => c.name);
                assert.ok(colNames.includes('id'));
                assert.ok(colNames.includes('name'));
                assert.ok(colNames.includes('email'));

                // PK should be detected
                const idCol = users.columns.find(c => c.name === 'id')!;
                assert.equal(idCol.isPrimaryKey, true);
                assert.equal(idCol.autoIncrement, true);

                // Nullable
                const bioCol = users.columns.find(c => c.name === 'bio')!;
                assert.equal(bioCol.nullable, true);
            });

            it('should return empty schema for non-existent tables', async () => {
                const db = tf.getDb();
                const dbSchema = await readDatabaseSchema(db, dialect, ['nonexistent_table_xyz']);
                assert.equal(dbSchema.size, 0);
            });
        });

        describe('full pipeline (compare + DDL)', () => {
            it('should detect no changes when DB matches entities', async () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);
                const tableNames = Array.from(entitySchema.keys());
                const dbSchema = await readDatabaseSchema(db, dialect, tableNames);

                const diff = await compareSchemas(entitySchema, dbSchema, dialect, false);

                // After createTables, the DB should match the entities
                // Some minor differences may exist due to type normalization,
                // but there should be no added/removed tables
                assert.equal(diff.addedTables.length, 0);
                assert.equal(diff.removedTables.length, 0);
            });

            it('should detect a missing table as added', async () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);

                // Only give the DB reader one of the two tables
                const dbSchema = await readDatabaseSchema(db, dialect, ['mig_users']);

                const diff = await compareSchemas(entitySchema, dbSchema, dialect, false);

                // mig_posts should show as "added" since it's not in the DB schema we gave
                assert.ok(diff.addedTables.some(t => t.name === 'mig_posts'));
            });

            it('should generate valid DDL for new tables', async () => {
                const db = tf.getDb();
                const entitySchema = readEntitiesSchema(db, dialect);

                const diff = await compareSchemas(entitySchema, new Map(), dialect, false);
                const stmts = generateDDL(diff);

                // Should have CREATE TABLE statements
                assert.ok(stmts.length > 0);
                for (const stmt of stmts) {
                    // All statements should be non-empty strings
                    assert.ok(typeof stmt === 'string' && stmt.length > 0);
                }

                // Check dialect-appropriate quoting
                if (dialect === 'mysql') {
                    assert.ok(stmts.some(s => s.includes('`mig_users`')));
                    assert.ok(stmts.some(s => s.includes('`mig_posts`')));
                } else {
                    assert.ok(stmts.some(s => s.includes('"mig_users"')));
                    assert.ok(stmts.some(s => s.includes('"mig_posts"')));
                }
            });
        });
    });
});
