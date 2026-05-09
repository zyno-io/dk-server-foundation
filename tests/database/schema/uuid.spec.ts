import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Blueprint, MySQLGrammar, PostgresGrammar } from '../../../src';
import { generateBuilderMigrationFromDiff } from '../../../src/database/migration/create/builder-regenerator';
import { ColumnSchema, SchemaDiff, TableSchema } from '../../../src/database/migration/create/schema-model';
import { forEachAdapter } from '../../shared/db';

const col = (overrides: Partial<ColumnSchema>): ColumnSchema => ({
    name: 'col',
    type: 'varchar',
    unsigned: false,
    nullable: false,
    autoIncrement: false,
    isPrimaryKey: false,
    ordinalPosition: 1,
    ...overrides
});

describe('uuid() / uuidString() builder methods', () => {
    describe('BlueprintBase mapping', () => {
        it('uuid() → BINARY(16) on MySQL', () => {
            const t = new Blueprint('users', new MySQLGrammar());
            t.uuid('id');
            assert.equal(t.columns[0].type, 'binary');
            assert.equal(t.columns[0].size, 16);
        });

        it('uuid() → UUID on PG', () => {
            const t = new Blueprint('users', new PostgresGrammar());
            t.uuid('id');
            assert.equal(t.columns[0].type, 'uuid');
            assert.equal(t.columns[0].size, undefined);
        });

        it('uuidString() → CHAR(36) on MySQL', () => {
            const t = new Blueprint('users', new MySQLGrammar());
            t.uuidString('id');
            assert.equal(t.columns[0].type, 'char');
            assert.equal(t.columns[0].size, 36);
        });

        it('uuidString() → CHAR(36) on PG', () => {
            const t = new Blueprint('users', new PostgresGrammar());
            t.uuidString('id');
            assert.equal(t.columns[0].type, 'char');
            assert.equal(t.columns[0].size, 36);
        });
    });

    describe('regenerator round-trip detection', () => {
        const renderTable = (column: ColumnSchema, dialect: 'mysql' | 'postgres'): string => {
            const tables: TableSchema[] = [{ name: 't', columns: [column], indexes: [], foreignKeys: [] }];
            const diff: SchemaDiff = { dialect, addedTables: tables, removedTables: [], modifiedTables: [] };
            return generateBuilderMigrationFromDiff(diff);
        };

        it('BINARY(16) round-trips to t.uuid()', () => {
            const src = renderTable(col({ name: 'id', type: 'binary', size: 16 }), 'mysql');
            assert.match(src, /t\.uuid\('id'\)/);
            assert.doesNotMatch(src, /t\.binary\(/);
        });

        it('CHAR(36) round-trips to t.uuidString()', () => {
            const src = renderTable(col({ name: 'id', type: 'char', size: 36 }), 'mysql');
            assert.match(src, /t\.uuidString\('id'\)/);
            assert.doesNotMatch(src, /t\.char\(/);
        });

        it('UUID round-trips to t.uuid() on PG', () => {
            const src = renderTable(col({ name: 'id', type: 'uuid' }), 'postgres');
            assert.match(src, /t\.uuid\('id'\)/);
        });

        it('non-16 BINARY still renders as t.binary()', () => {
            const src = renderTable(col({ name: 'data', type: 'binary', size: 32 }), 'mysql');
            assert.match(src, /t\.binary\('data', 32\)/);
        });

        it('non-36 CHAR still renders as t.char()', () => {
            const src = renderTable(col({ name: 'code', type: 'char', size: 8 }), 'mysql');
            assert.match(src, /t\.char\('code', 8\)/);
        });
    });

    describe('e2e: tables created with uuid() / uuidString()', () => {
        forEachAdapter(({ createFacade, type }) => {
            const tf = createFacade({ entities: [] });
            const tbl = `sb_uuid_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

            before(
                async () => {
                    await tf.start();
                    const db = tf.getDb();
                    await db.schema.create(tbl, t => {
                        t.id();
                        t.uuid('binId').notNull();
                        t.uuidString('strId').notNull();
                    });
                    await db.schema.flush();
                },
                { timeout: 15_000 }
            );

            after(
                async () => {
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

            it('introspects to the right physical types', { timeout: 10_000 }, async () => {
                const db = tf.getDb();
                if (type === 'mysql') {
                    const rows = (await db.rawQuery(
                        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tbl}' ORDER BY ORDINAL_POSITION`
                    )) as { COLUMN_NAME: string; DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number | null }[];
                    const binCol = rows.find(r => r.COLUMN_NAME === 'binId');
                    const strCol = rows.find(r => r.COLUMN_NAME === 'strId');
                    assert.equal(binCol!.DATA_TYPE.toLowerCase(), 'binary');
                    assert.equal(Number(binCol!.CHARACTER_MAXIMUM_LENGTH), 16);
                    assert.equal(strCol!.DATA_TYPE.toLowerCase(), 'char');
                    assert.equal(Number(strCol!.CHARACTER_MAXIMUM_LENGTH), 36);
                } else {
                    const rows = (await db.rawQuery(
                        `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = '${tbl}' AND table_schema = current_schema() ORDER BY ordinal_position`
                    )) as { column_name: string; data_type: string; character_maximum_length: number | null }[];
                    const binCol = rows.find(r => r.column_name === 'binId');
                    const strCol = rows.find(r => r.column_name === 'strId');
                    assert.equal(binCol!.data_type, 'uuid');
                    assert.equal(strCol!.data_type, 'character');
                    assert.equal(Number(strCol!.character_maximum_length), 36);
                }
            });
        });
    });
});
