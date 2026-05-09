import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AlterBlueprint, MySQLGrammar, PostgresGrammar } from '../../../src';
import { generateBuilderMigrationFromDiff } from '../../../src/database/migration/create/builder-regenerator';
import { ColumnSchema, SchemaDiff, TableDiff } from '../../../src/database/migration/create/schema-model';
import { forEachAdapter } from '../../shared/db';

const col = (overrides: Partial<ColumnSchema>): ColumnSchema => ({
    name: 'col',
    type: 'varchar',
    size: 100,
    unsigned: false,
    nullable: false,
    autoIncrement: false,
    isPrimaryKey: false,
    ordinalPosition: 1,
    ...overrides
});

describe('column positioning — .after() / .first()', () => {
    describe('AlterBlueprint records position via ColumnDefinition', () => {
        it('.after() sets afterColumn to a string', () => {
            const t = new AlterBlueprint('users', new MySQLGrammar());
            t.string('phone', 20).after('email');
            assert.equal(t.addedColumns[0].afterColumn, 'email');
        });

        it('.first() sets afterColumn to null', () => {
            const t = new AlterBlueprint('users', new MySQLGrammar());
            t.string('phone', 20).first();
            assert.equal(t.addedColumns[0].afterColumn, null);
        });

        it('no positioning by default', () => {
            const t = new AlterBlueprint('users', new MySQLGrammar());
            t.string('phone', 20);
            assert.equal(t.addedColumns[0].afterColumn, undefined);
        });
    });

    describe('MySQL grammar emits AFTER / FIRST in ADD COLUMN', () => {
        const g = new MySQLGrammar();

        it('AFTER clause', () => {
            const sql = g.addColumn('users', col({ name: 'phone', size: 20, afterColumn: 'email' }));
            assert.match(sql, /ADD COLUMN `phone` VARCHAR\(20\) NOT NULL AFTER `email`$/);
        });

        it('FIRST clause', () => {
            const sql = g.addColumn('users', col({ name: 'phone', size: 20, afterColumn: null }));
            assert.match(sql, /ADD COLUMN `phone` VARCHAR\(20\) NOT NULL FIRST$/);
        });

        it('no clause when afterColumn is undefined', () => {
            const sql = g.addColumn('users', col({ name: 'phone', size: 20 }));
            assert.match(sql, /ADD COLUMN `phone` VARCHAR\(20\) NOT NULL$/);
            assert.doesNotMatch(sql, /AFTER|FIRST/);
        });
    });

    describe('PostgresGrammar silently ignores positioning', () => {
        const g = new PostgresGrammar();

        it('does not emit AFTER even when set', () => {
            const sql = g.addColumn('users', col({ name: 'phone', size: 20, afterColumn: 'email' }));
            assert.match(sql, /ADD COLUMN "phone" VARCHAR\(20\) NOT NULL$/);
            assert.doesNotMatch(sql, /AFTER|FIRST/);
        });
    });

    describe('builder regenerator emits .after() in alter blocks (MySQL)', () => {
        it('places added column after the preceding existing column', () => {
            const td: TableDiff = {
                tableName: 'users',
                addedColumns: [col({ name: 'phone', size: 20 })],
                removedColumns: [],
                modifiedColumns: [],
                renamedColumns: [],
                reorderedColumns: [],
                addedIndexes: [],
                removedIndexes: [],
                addedForeignKeys: [],
                removedForeignKeys: [],
                primaryKeyChanged: false,
                addedEnumTypes: [],
                removedEnumTypes: [],
                modifiedEnumTypes: [],
                entityColumns: [
                    col({ name: 'id', type: 'int' }),
                    col({ name: 'email', size: 255 }),
                    col({ name: 'phone', size: 20 }),
                    col({ name: 'createdAt', type: 'datetime' })
                ]
            };
            const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [td] };
            const src = generateBuilderMigrationFromDiff(diff);
            assert.match(src, /t\.string\('phone', 20\)\.after\('email'\);/);
        });

        it('emits .first() when added column is at position 1', () => {
            const td: TableDiff = {
                tableName: 'users',
                addedColumns: [col({ name: 'firstcol', size: 20 })],
                removedColumns: [],
                modifiedColumns: [],
                renamedColumns: [],
                reorderedColumns: [],
                addedIndexes: [],
                removedIndexes: [],
                addedForeignKeys: [],
                removedForeignKeys: [],
                primaryKeyChanged: false,
                addedEnumTypes: [],
                removedEnumTypes: [],
                modifiedEnumTypes: [],
                entityColumns: [col({ name: 'firstcol', size: 20 }), col({ name: 'id', type: 'int' })]
            };
            const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [td] };
            const src = generateBuilderMigrationFromDiff(diff);
            assert.match(src, /t\.string\('firstcol', 20\)\.first\(\);/);
        });

        it('does not emit .after() for postgres dialect', () => {
            const td: TableDiff = {
                tableName: 'users',
                addedColumns: [col({ name: 'phone', size: 20 })],
                removedColumns: [],
                modifiedColumns: [],
                renamedColumns: [],
                reorderedColumns: [],
                addedIndexes: [],
                removedIndexes: [],
                addedForeignKeys: [],
                removedForeignKeys: [],
                primaryKeyChanged: false,
                addedEnumTypes: [],
                removedEnumTypes: [],
                modifiedEnumTypes: [],
                entityColumns: [col({ name: 'id', type: 'int' }), col({ name: 'email', size: 255 }), col({ name: 'phone', size: 20 })]
            };
            const diff: SchemaDiff = { dialect: 'postgres', addedTables: [], removedTables: [], modifiedTables: [td] };
            const src = generateBuilderMigrationFromDiff(diff);
            assert.doesNotMatch(src, /\.after\(/);
            assert.doesNotMatch(src, /\.first\(/);
        });
    });

    describe('e2e: alter().after() places column correctly (MySQL)', () => {
        forEachAdapter(({ createFacade, type }) => {
            const tf = createFacade({ entities: [] });
            const tbl = `sb_pos_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

            before(
                async () => {
                    if (type !== 'mysql') return;
                    await tf.start();
                    const db = tf.getDb();
                    await db.schema.create(tbl, t => {
                        t.id();
                        t.string('email', 255).notNull();
                        t.dateTime('createdAt').notNull().defaultRaw('CURRENT_TIMESTAMP');
                    });
                    await db.schema.flush();
                },
                { timeout: 15_000 }
            );

            after(
                async () => {
                    if (type !== 'mysql') return;
                    const db = tf.getDb();
                    try {
                        await db.schema.dropIfExists(tbl);
                    } catch {
                        /* ignore */
                    }
                    await tf.stop();
                },
                { timeout: 10_000 }
            );

            it('places phone AFTER email (mysql only)', { timeout: 15_000 }, async () => {
                if (type !== 'mysql') return; // MySQL-only positioning
                const db = tf.getDb();

                await db.schema.alter(tbl, t => {
                    t.string('phone', 20).nullable().after('email');
                });
                await db.schema.flush();

                const rows = (await db.rawQuery(
                    `SELECT COLUMN_NAME, ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tbl}' ORDER BY ORDINAL_POSITION`
                )) as { COLUMN_NAME: string; ORDINAL_POSITION: number }[];
                const order = rows.map(r => r.COLUMN_NAME);
                assert.deepEqual(order, ['id', 'email', 'phone', 'createdAt']);
            });
        });
    });
});
