import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateBuilderMigrationFile } from '../../../src/database/migration/create/builder-regenerator';
import { TableSchema } from '../../../src/database/migration/create/schema-model';

describe('builder regenerator', () => {
    it('renders a single table with id, string, boolean, dateTime', () => {
        const tables: TableSchema[] = [
            {
                name: 'users',
                columns: [
                    { name: 'id', type: 'bigint', unsigned: true, nullable: false, autoIncrement: true, isPrimaryKey: true, ordinalPosition: 1 },
                    {
                        name: 'email',
                        type: 'varchar',
                        size: 255,
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        ordinalPosition: 2
                    },
                    {
                        name: 'active',
                        type: 'tinyint',
                        size: 1,
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        ordinalPosition: 3
                    },
                    {
                        name: 'createdAt',
                        type: 'datetime',
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        defaultExpression: 'CURRENT_TIMESTAMP',
                        ordinalPosition: 4
                    }
                ],
                indexes: [],
                foreignKeys: []
            }
        ];

        const src = generateBuilderMigrationFile(tables);

        assert.match(src, /import \{ createMigration \} from '@zyno-io\/dk-server-foundation';/);
        assert.match(src, /export default createMigration\(async db => \{/);
        assert.match(src, /await db\.schema\.create\('users', t => \{/);
        assert.match(src, /t\.bigInteger\('id'\)\.unsigned\(\)\.autoIncrement\(\)\.primary\(\);/);
        assert.match(src, /t\.string\('email', 255\);/);
        assert.match(src, /t\.boolean\('active'\);/);
        assert.match(src, /t\.dateTime\('createdAt'\)\.defaultRaw\('CURRENT_TIMESTAMP'\);/);
    });

    it('renders nullable, default literal, ON UPDATE', () => {
        const tables: TableSchema[] = [
            {
                name: 't',
                columns: [
                    {
                        name: 'a',
                        type: 'varchar',
                        size: 100,
                        unsigned: false,
                        nullable: true,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        ordinalPosition: 1
                    },
                    {
                        name: 'b',
                        type: 'varchar',
                        size: 50,
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        defaultValue: 'hi',
                        ordinalPosition: 2
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        defaultExpression: 'CURRENT_TIMESTAMP',
                        onUpdateExpression: 'CURRENT_TIMESTAMP',
                        ordinalPosition: 3
                    }
                ],
                indexes: [],
                foreignKeys: []
            }
        ];

        const src = generateBuilderMigrationFile(tables);

        assert.match(src, /t\.string\('a', 100\)\.nullable\(\);/);
        assert.match(src, /t\.string\('b', 50\)\.default\('hi'\);/);
        assert.match(src, /t\.dateTime\('updatedAt'\)\.defaultRaw\('CURRENT_TIMESTAMP'\)\.onUpdate\('CURRENT_TIMESTAMP'\);/);
    });

    it('renders enum with values and explicit type name', () => {
        const tables: TableSchema[] = [
            {
                name: 't',
                columns: [
                    {
                        name: 'status',
                        type: 'enum',
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        enumValues: ['active', 'pending'],
                        enumTypeName: 'shared_status_enum',
                        ordinalPosition: 1
                    }
                ],
                indexes: [],
                foreignKeys: []
            }
        ];
        const src = generateBuilderMigrationFile(tables);
        assert.match(src, /t\.enum\('status', \['active', 'pending'\], 'shared_status_enum'\);/);
    });

    it('renders composite primary key', () => {
        const tables: TableSchema[] = [
            {
                name: 'pivot',
                columns: [
                    { name: 'a', type: 'int', unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: true, ordinalPosition: 1 },
                    { name: 'b', type: 'int', unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: true, ordinalPosition: 2 }
                ],
                indexes: [],
                foreignKeys: []
            }
        ];
        const src = generateBuilderMigrationFile(tables);
        assert.match(src, /t\.integer\('a'\);/); // no .primary() on individual column
        assert.match(src, /t\.integer\('b'\);/);
        assert.match(src, /t\.primary\(\['a', 'b'\]\);/);
    });

    it('renders index, unique, foreign key (with default-name suppression)', () => {
        const tables: TableSchema[] = [
            {
                name: 'posts',
                columns: [
                    { name: 'id', type: 'int', unsigned: false, nullable: false, autoIncrement: true, isPrimaryKey: true, ordinalPosition: 1 },
                    { name: 'userId', type: 'int', unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: false, ordinalPosition: 2 },
                    {
                        name: 'slug',
                        type: 'varchar',
                        size: 200,
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        ordinalPosition: 3
                    }
                ],
                indexes: [
                    { name: 'posts_userId_index', columns: ['userId'], unique: false, spatial: false },
                    { name: 'posts_slug_unique', columns: ['slug'], unique: true, spatial: false }
                ],
                foreignKeys: [
                    {
                        name: 'posts_userId_foreign',
                        columns: ['userId'],
                        referencedTable: 'users',
                        referencedColumns: ['id'],
                        onDelete: 'CASCADE',
                        onUpdate: 'RESTRICT'
                    }
                ]
            }
        ];

        const src = generateBuilderMigrationFile(tables);

        assert.match(src, /t\.index\('userId'\);/);
        assert.match(src, /t\.unique\('slug'\);/);
        assert.match(src, /t\.foreign\('userId'\)\.references\('id'\)\.on\('users'\)\.onDelete\('CASCADE'\);/);
        // RESTRICT is the default, should be omitted
        assert.doesNotMatch(src, /onUpdate\('RESTRICT'\)/);
    });

    it('renders custom index/FK names when not matching default convention', () => {
        const tables: TableSchema[] = [
            {
                name: 'orders',
                columns: [
                    {
                        name: 'sku',
                        type: 'varchar',
                        size: 64,
                        unsigned: false,
                        nullable: false,
                        autoIncrement: false,
                        isPrimaryKey: false,
                        ordinalPosition: 1
                    }
                ],
                indexes: [{ name: 'idx_legacy_sku', columns: ['sku'], unique: false, spatial: false }],
                foreignKeys: []
            }
        ];
        const src = generateBuilderMigrationFile(tables);
        assert.match(src, /t\.index\('sku', 'idx_legacy_sku'\);/);
    });

    it('renders POINT and SPATIAL index', () => {
        const tables: TableSchema[] = [
            {
                name: 'places',
                columns: [
                    { name: 'loc', type: 'point', unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: false, ordinalPosition: 1 }
                ],
                indexes: [{ name: 'places_loc_spatial', columns: ['loc'], unique: false, spatial: true }],
                foreignKeys: []
            }
        ];
        const src = generateBuilderMigrationFile(tables);
        assert.match(src, /t\.point\('loc'\);/);
        assert.match(src, /t\.spatialIndex\('loc'\);/);
    });
});
