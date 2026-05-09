import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateBuilderMigrationFromDiff } from '../../../src/database/migration/create/builder-regenerator';
import { ColumnSchema, SchemaDiff, TableDiff, TableSchema } from '../../../src/database/migration/create/schema-model';

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

const emptyTableDiff = (tableName: string): TableDiff => ({
    tableName,
    addedColumns: [],
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
    modifiedEnumTypes: []
});

describe('generateBuilderMigrationFromDiff', () => {
    it('drop removed tables', () => {
        const diff: SchemaDiff = {
            dialect: 'mysql',
            addedTables: [],
            removedTables: [{ name: 'legacy', columns: [], indexes: [], foreignKeys: [] }],
            modifiedTables: []
        };
        const src = generateBuilderMigrationFromDiff(diff);
        assert.match(src, /await db\.schema\.drop\('legacy'\);/);
    });

    it('create added tables', () => {
        const table: TableSchema = {
            name: 'orgs',
            columns: [
                col({ name: 'id', type: 'bigint', unsigned: true, autoIncrement: true, isPrimaryKey: true }),
                col({ name: 'name', type: 'varchar', size: 100 })
            ],
            indexes: [],
            foreignKeys: []
        };
        const diff: SchemaDiff = { dialect: 'mysql', addedTables: [table], removedTables: [], modifiedTables: [] };
        const src = generateBuilderMigrationFromDiff(diff);
        assert.match(src, /await db\.schema\.create\('orgs', t => \{/);
        assert.match(src, /t\.bigInteger\('id'\)\.unsigned\(\)\.autoIncrement\(\)\.primary\(\);/);
        assert.match(src, /t\.string\('name', 100\);/);
    });

    it('alter — add / drop / rename columns', () => {
        const td = emptyTableDiff('users');
        td.addedColumns = [col({ name: 'phone', size: 20, nullable: true })];
        td.removedColumns = [col({ name: 'legacy' })];
        td.renamedColumns = [{ from: 'old', to: 'new', column: col({ name: 'new' }) }];

        const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [td] };
        const src = generateBuilderMigrationFromDiff(diff);

        assert.match(src, /await db\.schema\.alter\('users', t => \{/);
        assert.match(src, /t\.dropColumn\('legacy'\);/);
        assert.match(src, /t\.renameColumn\('old', 'new'\);/);
        assert.match(src, /t\.string\('phone', 20\)\.nullable\(\);/);
    });

    it('alter — modified column gets .change() appended', () => {
        const td = emptyTableDiff('users');
        const newCol = col({ name: 'email', size: 500, nullable: true });
        td.modifiedColumns = [
            {
                name: 'email',
                oldColumn: col({ name: 'email', size: 255 }),
                newColumn: newCol,
                typeChanged: true,
                nullableChanged: true,
                defaultChanged: false,
                autoIncrementChanged: false,
                onUpdateChanged: false
            }
        ];
        const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [td] };
        const src = generateBuilderMigrationFromDiff(diff);

        assert.match(src, /t\.string\('email', 500\)\.nullable\(\)\.change\(\);/);
    });

    it('alter — primary key drop + replace', () => {
        const td = emptyTableDiff('pivot');
        td.primaryKeyChanged = true;
        td.oldPrimaryKey = ['a'];
        td.newPrimaryKey = ['a', 'b'];

        const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [td] };
        const src = generateBuilderMigrationFromDiff(diff);

        assert.match(src, /t\.dropPrimary\(\);/);
        assert.match(src, /t\.primary\(\['a', 'b'\]\);/);
    });

    it('alter — drop index, drop FK, add FK, add index', () => {
        const td = emptyTableDiff('posts');
        td.removedIndexes = [{ name: 'posts_oldcol_index', columns: ['oldcol'], unique: false, spatial: false }];
        td.removedForeignKeys = [
            { name: 'posts_old_fk', columns: ['x'], referencedTable: 'y', referencedColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' }
        ];
        td.addedIndexes = [{ name: 'posts_slug_index', columns: ['slug'], unique: false, spatial: false }];
        td.addedForeignKeys = [
            {
                name: 'posts_userId_foreign',
                columns: ['userId'],
                referencedTable: 'users',
                referencedColumns: ['id'],
                onDelete: 'CASCADE',
                onUpdate: 'RESTRICT'
            }
        ];

        const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [td] };
        const src = generateBuilderMigrationFromDiff(diff);

        assert.match(src, /t\.dropIndex\('posts_oldcol_index'\);/);
        assert.match(src, /t\.dropForeign\('posts_old_fk'\);/);
        assert.match(src, /t\.index\('slug'\);/);
        assert.match(src, /t\.foreign\('userId'\)\.references\('id'\)\.on\('users'\)\.onDelete\('CASCADE'\);/);
    });

    it('PG enum lifecycle — added type via enumType, modified ADD VALUE via raw, removed via DROP CAST + DROP TYPE', () => {
        const td = emptyTableDiff('t');
        td.addedEnumTypes = [{ typeName: 'new_status', values: ['a', 'b'] }];
        td.modifiedEnumTypes = [
            { typeName: 'existing', added: ['c'], removed: [], newValues: ['a', 'b', 'c'], tableName: 't', columnName: 'status' }
        ];
        td.removedEnumTypes = ['old_kind'];
        // Need at least one inner op so the alter block isn't empty (otherwise pre/post lines still emit but no block)
        td.addedColumns = [col({ name: 'newcol' })];

        const diff: SchemaDiff = { dialect: 'postgres', addedTables: [], removedTables: [], modifiedTables: [td] };
        const src = generateBuilderMigrationFromDiff(diff);

        assert.match(src, /await db\.schema\.enumType\('new_status', \['a', 'b'\]\);/);
        assert.match(src, /ALTER TYPE "existing" ADD VALUE IF NOT EXISTS \\'c\\'/);
        assert.match(src, /DROP CAST IF EXISTS \(text AS "old_kind"\)/);
        assert.match(src, /DROP TYPE IF EXISTS "old_kind"/);
    });

    it('returns a no-changes file when diff is empty', () => {
        const diff: SchemaDiff = { dialect: 'mysql', addedTables: [], removedTables: [], modifiedTables: [] };
        const src = generateBuilderMigrationFromDiff(diff);
        assert.match(src, /No schema changes detected/);
    });
});
