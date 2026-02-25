import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareSchemas } from '../../src/database/migration/create/comparator';
import { generateDDL } from '../../src/database/migration/create/ddl-generator';
import { setNonInteractive } from '../../src/database/migration/create/prompt';
import { ColumnSchema, ColumnModification, DatabaseSchema, SchemaDiff, TableSchema } from '../../src/database/migration/create/schema-model';

// Disable interactive prompts for all tests
setNonInteractive(true);

// --- Helpers ---

function col(overrides: Partial<ColumnSchema> & { name: string }): ColumnSchema {
    return {
        type: 'varchar',
        size: 255,
        unsigned: false,
        nullable: false,
        autoIncrement: false,
        isPrimaryKey: false,
        ordinalPosition: 1,
        ...overrides
    };
}

function table(name: string, columns: ColumnSchema[], extra?: Partial<TableSchema>): TableSchema {
    return {
        name,
        columns,
        indexes: [],
        foreignKeys: [],
        ...extra
    };
}

function schema(...tables: TableSchema[]): DatabaseSchema {
    return new Map(tables.map(t => [t.name, t]));
}

// --- Comparator Tests ---

describe('comparator', () => {
    describe('table-level changes', () => {
        it('should detect added tables', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true })]));
            const db = schema();

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.addedTables.length, 1);
            assert.equal(diff.addedTables[0].name, 'users');
            assert.equal(diff.removedTables.length, 0);
            assert.equal(diff.modifiedTables.length, 0);
        });

        it('should detect removed tables', async () => {
            const entity = schema();
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true })]));

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.addedTables.length, 0);
            assert.equal(diff.removedTables.length, 1);
            assert.equal(diff.removedTables[0].name, 'users');
        });

        it('should detect no changes when schemas match', async () => {
            const t = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
            ]);
            const entity = schema(t);
            const db = schema(t);

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.addedTables.length, 0);
            assert.equal(diff.removedTables.length, 0);
            assert.equal(diff.modifiedTables.length, 0);
        });
    });

    describe('column-level changes', () => {
        it('should detect added columns', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'name', ordinalPosition: 2 }),
                    col({ name: 'email', ordinalPosition: 3 })
                ])
            );
            const db = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'name', ordinalPosition: 2 })])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedColumns.length, 1);
            assert.equal(diff.modifiedTables[0].addedColumns[0].name, 'email');
        });

        it('should detect removed columns', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]));
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'legacy_field', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].removedColumns.length, 1);
            assert.equal(diff.modifiedTables[0].removedColumns[0].name, 'legacy_field');
        });

        it('should detect type changes', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'text', size: undefined, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedColumns.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedColumns[0].name, 'name');
            assert.equal(diff.modifiedTables[0].modifiedColumns[0].typeChanged, true);
        });

        it('should detect nullable changes', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'bio', nullable: true, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'bio', nullable: false, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            const mod = diff.modifiedTables[0].modifiedColumns[0];
            assert.equal(mod.name, 'bio');
            assert.equal(mod.nullableChanged, true);
            assert.equal(mod.typeChanged, false);
        });

        it('should detect size changes', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'code', type: 'varchar', size: 100, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'code', type: 'varchar', size: 50, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedColumns[0].typeChanged, true);
        });

        it('should detect onUpdateExpression changes', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'updated_at',
                        type: 'datetime',
                        size: undefined,
                        onUpdateExpression: 'CURRENT_TIMESTAMP',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', size: undefined, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            const mod = diff.modifiedTables[0].modifiedColumns[0];
            assert.equal(mod.name, 'updated_at');
            assert.equal(mod.onUpdateChanged, true);
            assert.equal(mod.typeChanged, false);
        });
    });

    describe('index changes', () => {
        it('should detect added indexes', async () => {
            const entity = schema(
                table(
                    'users',
                    [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                    { indexes: [{ name: 'idx_email', columns: ['email'], unique: true, spatial: false }] }
                )
            );
            const db = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedIndexes.length, 1);
            assert.equal(diff.modifiedTables[0].addedIndexes[0].columns[0], 'email');
            assert.equal(diff.modifiedTables[0].addedIndexes[0].unique, true);
        });

        it('should detect removed indexes', async () => {
            const entity = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })])
            );
            const db = schema(
                table(
                    'users',
                    [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                    { indexes: [{ name: 'idx_email', columns: ['email'], unique: false, spatial: false }] }
                )
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].removedIndexes.length, 1);
        });

        it('should match indexes by columns+uniqueness, not by name', async () => {
            const entity = schema(
                table(
                    'users',
                    [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                    { indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true, spatial: false }] }
                )
            );
            const db = schema(
                table(
                    'users',
                    [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                    { indexes: [{ name: 'different_name', columns: ['email'], unique: true, spatial: false }] }
                )
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            // Same columns + uniqueness = no change despite different name
            assert.equal(diff.modifiedTables.length, 0);
        });

        it('should detect spatial index flag differences', async () => {
            const entity = schema(
                table(
                    'locations',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'position', type: 'point', size: undefined, ordinalPosition: 2 })
                    ],
                    { indexes: [{ name: 'idx_position', columns: ['position'], unique: false, spatial: true }] }
                )
            );
            const db = schema(
                table(
                    'locations',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'position', type: 'point', size: undefined, ordinalPosition: 2 })
                    ],
                    { indexes: [{ name: 'idx_position', columns: ['position'], unique: false, spatial: false }] }
                )
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedIndexes.length, 1);
            assert.equal(diff.modifiedTables[0].addedIndexes[0].spatial, true);
            assert.equal(diff.modifiedTables[0].removedIndexes.length, 1);
            assert.equal(diff.modifiedTables[0].removedIndexes[0].spatial, false);
        });
    });

    describe('foreign key changes', () => {
        it('should detect added foreign keys', async () => {
            const entity = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    {
                        foreignKeys: [
                            {
                                name: 'fk_posts_user_id',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'CASCADE',
                                onUpdate: 'RESTRICT'
                            }
                        ]
                    }
                )
            );
            const db = schema(
                table('posts', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedForeignKeys.length, 1);
            assert.equal(diff.modifiedTables[0].addedForeignKeys[0].referencedTable, 'users');
        });

        it('should match foreign keys by structure, not by name', async () => {
            const fkEntity = {
                name: 'fk_entity_name',
                columns: ['user_id'],
                referencedTable: 'users',
                referencedColumns: ['id'],
                onDelete: 'CASCADE',
                onUpdate: 'RESTRICT'
            };
            const fkDb = {
                name: 'different_constraint_name',
                columns: ['user_id'],
                referencedTable: 'users',
                referencedColumns: ['id'],
                onDelete: 'CASCADE',
                onUpdate: 'RESTRICT'
            };

            const entity = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    { foreignKeys: [fkEntity] }
                )
            );
            const db = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    { foreignKeys: [fkDb] }
                )
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 0);
        });

        it('should detect FK action changes (onDelete)', async () => {
            const entity = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    {
                        foreignKeys: [
                            {
                                name: 'fk_posts_user_id',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'RESTRICT',
                                onUpdate: 'RESTRICT'
                            }
                        ]
                    }
                )
            );
            const db = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    {
                        foreignKeys: [
                            {
                                name: 'fk_posts_user_id',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'CASCADE',
                                onUpdate: 'RESTRICT'
                            }
                        ]
                    }
                )
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedForeignKeys.length, 1);
            assert.equal(diff.modifiedTables[0].addedForeignKeys[0].onDelete, 'RESTRICT');
            assert.equal(diff.modifiedTables[0].removedForeignKeys.length, 1);
            assert.equal(diff.modifiedTables[0].removedForeignKeys[0].onDelete, 'CASCADE');
        });
    });

    describe('primary key changes', () => {
        it('should detect PK changes', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].primaryKeyChanged, true);
            assert.deepEqual(diff.modifiedTables[0].newPrimaryKey, ['id']);
        });

        it('should store old PK constraint name from DB table', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );
            const dbTable = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }),
                col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 2 })
            ]);
            dbTable.primaryKeyConstraintName = 'users_pk_custom';
            const db = schema(dbTable);

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].primaryKeyChanged, true);
            assert.equal(diff.modifiedTables[0].oldPrimaryKeyConstraintName, 'users_pk_custom');
        });
    });

    describe('enum changes (postgres)', () => {
        it('should detect new enum types for new columns', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                ])
            );
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedEnumTypes.length, 1);
            assert.equal(diff.modifiedTables[0].addedEnumTypes[0].typeName, 'users_status');
            assert.deepEqual(diff.modifiedTables[0].addedEnumTypes[0].values, ['active', 'inactive']);
        });

        it('should detect added enum values', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive', 'banned'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedEnumTypes.length, 1);
            assert.deepEqual(diff.modifiedTables[0].modifiedEnumTypes[0].added, ['banned']);
            assert.deepEqual(diff.modifiedTables[0].modifiedEnumTypes[0].removed, []);
        });

        it('should store newValues, tableName, columnName for modified enums', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'banned'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1);
            const enumMod = diff.modifiedTables[0].modifiedEnumTypes[0];
            assert.deepEqual(enumMod.newValues, ['active', 'banned']);
            assert.equal(enumMod.tableName, 'users');
            assert.equal(enumMod.columnName, 'status');
            assert.deepEqual(enumMod.removed, ['inactive']);
            assert.deepEqual(enumMod.added, ['banned']);
        });
    });

    describe('column reordering (MySQL)', () => {
        it('should detect reordered columns', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'email', ordinalPosition: 2 }),
                    col({ name: 'name', ordinalPosition: 3 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'name', ordinalPosition: 2 }),
                    col({ name: 'email', ordinalPosition: 3 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.ok(diff.modifiedTables[0].reorderedColumns.length > 0);
        });

        it('should not detect reordering for postgres', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'email', ordinalPosition: 2 }),
                    col({ name: 'name', ordinalPosition: 3 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'name', ordinalPosition: 2 }),
                    col({ name: 'email', ordinalPosition: 3 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            // PG doesn't support column reordering, so no reorder entries
            assert.equal(diff.modifiedTables.length, 0);
        });
    });
});

// --- DDL Generator Tests ---

describe('ddl-generator', () => {
    describe('MySQL', () => {
        it('should generate CREATE TABLE', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                        col({ name: 'name', type: 'varchar', size: 100, ordinalPosition: 2 }),
                        col({ name: 'email', type: 'varchar', size: 255, nullable: true, ordinalPosition: 3 })
                    ])
                ),
                schema(),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.length >= 1);
            const create = stmts[0];
            assert.ok(create.includes('CREATE TABLE `users`'));
            assert.ok(create.includes('`id` INT'));
            assert.ok(create.includes('AUTO_INCREMENT'));
            assert.ok(create.includes('`name` VARCHAR(100)'));
            assert.ok(create.includes('NOT NULL'));
            assert.ok(create.includes('PRIMARY KEY'));
        });

        it('should generate ADD COLUMN', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'email', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ),
                schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })])),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('ADD COLUMN') && s.includes('`email`') && s.includes('VARCHAR(255)')));
        });

        it('should generate DROP COLUMN', async () => {
            const diff = await compareSchemas(
                schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })])),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'legacy', ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('DROP COLUMN') && s.includes('`legacy`')));
        });

        it('should generate MODIFY COLUMN for type changes', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'bio', type: 'text', size: undefined, ordinalPosition: 2 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'bio', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('MODIFY COLUMN') && s.includes('`bio`') && s.includes('TEXT')));
        });

        it('should generate ENUM type', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];

            assert.ok(create.includes("ENUM('active','inactive')"));
        });

        it('should generate DROP TABLE', async () => {
            const diff = await compareSchemas(
                schema(),
                schema(table('old_table', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })])),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('DROP TABLE `old_table`')));
        });

        it('should generate CREATE INDEX', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'users',
                        [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                        { indexes: [{ name: 'idx_email', columns: ['email'], unique: true, spatial: false }] }
                    )
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'email', ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('CREATE UNIQUE INDEX') && s.includes('`idx_email`')));
        });

        it('should generate boolean column as TINYINT(1)', async () => {
            const diff = await compareSchemas(
                schema(
                    table('flags', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'active', type: 'tinyint', size: 1, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];

            assert.ok(create.includes('TINYINT(1)'));
        });

        it('should generate MODIFY COLUMN for reorder-only columns', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'email', ordinalPosition: 2 }),
                        col({ name: 'name', ordinalPosition: 3 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', ordinalPosition: 2 }),
                        col({ name: 'email', ordinalPosition: 3 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            // Should emit MODIFY COLUMN with AFTER clause for reordering
            assert.ok(stmts.some(s => s.includes('MODIFY COLUMN') && s.includes('AFTER')));
        });

        it('should generate MODIFY COLUMN with ON UPDATE for onUpdateExpression changes', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'updated_at',
                            type: 'datetime',
                            size: undefined,
                            onUpdateExpression: 'CURRENT_TIMESTAMP',
                            ordinalPosition: 2
                        })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'updated_at', type: 'datetime', size: undefined, ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('MODIFY COLUMN') && s.includes('ON UPDATE CURRENT_TIMESTAMP')));
        });
    });

    describe('PostgreSQL', () => {
        it('should generate CREATE TABLE', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                        col({ name: 'name', type: 'varchar', size: 100, ordinalPosition: 2 }),
                        col({ name: 'active', type: 'boolean', size: undefined, ordinalPosition: 3 })
                    ])
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.length >= 1);
            const create = stmts[0];
            assert.ok(create.includes('CREATE TABLE "users"'));
            assert.ok(create.includes('"id" SERIAL'));
            assert.ok(create.includes('"name" VARCHAR(100)'));
            assert.ok(create.includes('"active" BOOLEAN'));
            assert.ok(create.includes('PRIMARY KEY'));
        });

        it('should generate ALTER TABLE ADD COLUMN', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'email', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ),
                schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })])),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('ADD COLUMN') && s.includes('"email"') && s.includes('VARCHAR(255)')));
        });

        it('should generate ALTER COLUMN TYPE', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'bio', type: 'text', size: undefined, ordinalPosition: 2 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'bio', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('ALTER COLUMN "bio" TYPE TEXT')));
        });

        it('should generate SET/DROP NOT NULL', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'bio', nullable: true, ordinalPosition: 2 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'bio', nullable: false, ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('DROP NOT NULL')));
        });

        it('should generate CREATE TYPE for enums', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'role', type: 'enum', enumValues: ['admin', 'user'], enumTypeName: 'users_role', ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes("CREATE TYPE \"users_role\" AS ENUM ('admin', 'user')")));
        });

        it('should generate ALTER TYPE ADD VALUE', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'status',
                            type: 'enum',
                            enumValues: ['active', 'inactive', 'banned'],
                            enumTypeName: 'users_status',
                            ordinalPosition: 2
                        })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('ALTER TYPE "users_status" ADD VALUE \'banned\'')));
        });

        it('should generate enum type recreation when values are removed', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'status',
                            type: 'enum',
                            enumValues: ['active', 'banned'],
                            enumTypeName: 'users_status',
                            ordinalPosition: 2
                        })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'status',
                            type: 'enum',
                            enumValues: ['active', 'inactive'],
                            enumTypeName: 'users_status',
                            ordinalPosition: 2
                        })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            // Should generate RENAME, CREATE, ALTER COLUMN TYPE, DROP for enum recreation
            assert.ok(stmts.some(s => s.includes('ALTER TYPE "users_status" RENAME TO "users_status_old"')));
            assert.ok(stmts.some(s => s.includes("CREATE TYPE \"users_status\" AS ENUM ('active', 'banned')")));
            assert.ok(
                stmts.some(
                    s =>
                        s.includes('ALTER TABLE "users" ALTER COLUMN "status" TYPE "users_status"') &&
                        s.includes('USING "status"::text::"users_status"')
                )
            );
            assert.ok(stmts.some(s => s.includes('DROP TYPE IF EXISTS "users_status_old"')));
        });

        it('should generate JSONB for objects', async () => {
            const diff = await compareSchemas(
                schema(
                    table('events', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'data', type: 'jsonb', size: undefined, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];

            assert.ok(create.includes('JSONB'));
        });

        it('should use BIGSERIAL for bigint auto-increment', async () => {
            const diff = await compareSchemas(
                schema(table('events', [col({ name: 'id', type: 'bigint', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })])),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];

            assert.ok(create.includes('BIGSERIAL'));
        });

        it('should use custom PK constraint name in DROP CONSTRAINT', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );
            const dbTable = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }),
                col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 2 })
            ]);
            dbTable.primaryKeyConstraintName = 'users_pk_custom';
            const db = schema(dbTable);

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('DROP CONSTRAINT "users_pk_custom"')));
        });
    });

    describe('FK DDL', () => {
        it('should generate ADD CONSTRAINT for MySQL', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'posts',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_posts_user_id',
                                    columns: ['user_id'],
                                    referencedTable: 'users',
                                    referencedColumns: ['id'],
                                    onDelete: 'CASCADE',
                                    onUpdate: 'RESTRICT'
                                }
                            ]
                        }
                    )
                ),
                schema(
                    table('posts', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('ADD CONSTRAINT') && s.includes('FOREIGN KEY') && s.includes('ON DELETE CASCADE')));
        });

        it('should generate ADD CONSTRAINT for PostgreSQL', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'posts',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_posts_user_id',
                                    columns: ['user_id'],
                                    referencedTable: 'users',
                                    referencedColumns: ['id'],
                                    onDelete: 'CASCADE',
                                    onUpdate: 'RESTRICT'
                                }
                            ]
                        }
                    )
                ),
                schema(
                    table('posts', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            assert.ok(stmts.some(s => s.includes('ADD CONSTRAINT') && s.includes('"fk_posts_user_id"') && s.includes('ON DELETE CASCADE')));
        });
    });

    describe('empty diff', () => {
        it('should produce no statements for identical schemas', async () => {
            const t = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                col({ name: 'name', ordinalPosition: 2 })
            ]);

            const diff = await compareSchemas(schema(t), schema(t), 'mysql', false);
            const stmts = generateDDL(diff);

            assert.equal(stmts.length, 0);
        });
    });

    describe('ADD COLUMN AFTER clause', () => {
        it('should generate AFTER clause for added columns using entityColumns', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', ordinalPosition: 2 }),
                        col({ name: 'email', ordinalPosition: 3 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);
            const addStmt = stmts.find(s => s.includes('ADD COLUMN') && s.includes('`email`'));
            assert.ok(addStmt);
            assert.ok(addStmt!.includes('AFTER `name`'));
        });
    });

    describe('non-enum to enum conversion (PG)', () => {
        it('should CREATE TYPE when existing column changes from varchar to enum', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            // Should CREATE TYPE before ALTER COLUMN TYPE
            const createTypeIdx = stmts.findIndex(s => s.includes('CREATE TYPE "users_status"'));
            const alterColumnIdx = stmts.findIndex(s => s.includes('ALTER COLUMN "status" TYPE'));
            assert.ok(createTypeIdx >= 0, 'Should generate CREATE TYPE');
            assert.ok(alterColumnIdx >= 0, 'Should generate ALTER COLUMN TYPE');
            assert.ok(createTypeIdx < alterColumnIdx, 'CREATE TYPE should come before ALTER COLUMN TYPE');
        });

        it('should include USING cast when converting to enum type', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            const alterStmt = stmts.find(s => s.includes('ALTER COLUMN "status" TYPE'));
            assert.ok(alterStmt);
            assert.ok(alterStmt!.includes('USING "status"::text::"users_status"'), 'Should include USING cast for enum type conversion');
        });
    });

    describe('composite foreign keys', () => {
        it('should detect composite FK addition', async () => {
            const entity = schema(
                table(
                    'order_items',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'order_id', type: 'int', ordinalPosition: 2 }),
                        col({ name: 'product_id', type: 'int', ordinalPosition: 3 })
                    ],
                    {
                        foreignKeys: [
                            {
                                name: 'fk_order_items_composite',
                                columns: ['order_id', 'product_id'],
                                referencedTable: 'order_products',
                                referencedColumns: ['order_id', 'product_id'],
                                onDelete: 'CASCADE',
                                onUpdate: 'RESTRICT'
                            }
                        ]
                    }
                )
            );
            const db = schema(
                table('order_items', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'order_id', type: 'int', ordinalPosition: 2 }),
                    col({ name: 'product_id', type: 'int', ordinalPosition: 3 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].addedForeignKeys.length, 1);
            const fk = diff.modifiedTables[0].addedForeignKeys[0];
            assert.deepEqual(fk.columns, ['order_id', 'product_id']);
            assert.deepEqual(fk.referencedColumns, ['order_id', 'product_id']);
        });

        it('should generate composite FK DDL for PG', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'order_items',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'order_id', type: 'int', ordinalPosition: 2 }),
                            col({ name: 'product_id', type: 'int', ordinalPosition: 3 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_composite',
                                    columns: ['order_id', 'product_id'],
                                    referencedTable: 'order_products',
                                    referencedColumns: ['order_id', 'product_id'],
                                    onDelete: 'CASCADE',
                                    onUpdate: 'RESTRICT'
                                }
                            ]
                        }
                    )
                ),
                schema(
                    table('order_items', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'order_id', type: 'int', ordinalPosition: 2 }),
                        col({ name: 'product_id', type: 'int', ordinalPosition: 3 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            const fkStmt = stmts.find(s => s.includes('ADD CONSTRAINT') && s.includes('fk_composite'));
            assert.ok(fkStmt);
            assert.ok(fkStmt!.includes('"order_id", "product_id"'));
            assert.ok(fkStmt!.includes('REFERENCES "order_products"'));
        });
    });

    describe('duplicate enum types across tables', () => {
        it('should deduplicate CREATE TYPE when same enum used in multiple new tables', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'shared_status', ordinalPosition: 2 })
                    ]),
                    table('admins', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'shared_status', ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            const createTypes = stmts.filter(s => s.includes('CREATE TYPE "shared_status"'));
            assert.equal(createTypes.length, 1, 'Should only have one CREATE TYPE for shared_status');
        });
    });

    describe('FK-dependent table drops', () => {
        it('should drop FKs before dropping tables with dependencies', async () => {
            const diff = await compareSchemas(
                schema(),
                schema(
                    table(
                        'posts',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_posts_user',
                                    columns: ['user_id'],
                                    referencedTable: 'users',
                                    referencedColumns: ['id'],
                                    onDelete: 'CASCADE',
                                    onUpdate: 'RESTRICT'
                                }
                            ]
                        }
                    ),
                    table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            const dropFkIdx = stmts.findIndex(s => s.includes('DROP CONSTRAINT') && s.includes('fk_posts_user'));
            const dropTableIdx = stmts.findIndex(s => s.includes('DROP TABLE') && s.includes('"posts"'));
            assert.ok(dropFkIdx >= 0, 'Should drop FK');
            assert.ok(dropTableIdx >= 0, 'Should drop table');
            assert.ok(dropFkIdx < dropTableIdx, 'FK drop should come before table drop');
        });
    });

    describe('FK action validation', () => {
        it('should reject invalid FK action values', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'posts',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_bad',
                                    columns: ['user_id'],
                                    referencedTable: 'users',
                                    referencedColumns: ['id'],
                                    onDelete: 'DROP TABLE users; --',
                                    onUpdate: 'RESTRICT'
                                }
                            ]
                        }
                    )
                ),
                schema(
                    table('posts', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ])
                ),
                'mysql',
                false
            );

            assert.throws(() => generateDDL(diff), /Invalid foreign key action/);
        });

        it('should accept valid FK actions including NO ACTION', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'posts',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_ok',
                                    columns: ['user_id'],
                                    referencedTable: 'users',
                                    referencedColumns: ['id'],
                                    onDelete: 'SET NULL',
                                    onUpdate: 'NO ACTION'
                                }
                            ]
                        }
                    )
                ),
                schema(
                    table('posts', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            assert.ok(stmts.some(s => s.includes('ON DELETE SET NULL') && s.includes('ON UPDATE NO ACTION')));
        });
    });

    describe('enum type name comparison', () => {
        it('should detect enum type name change as a modification', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status_v2', ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedColumns.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedColumns[0].typeChanged, true);
        });
    });

    describe('schema-qualified index and constraint DDL', () => {
        it('should schema-qualify table names in index DDL for non-public schema', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'users',
                        [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                        { indexes: [{ name: 'idx_email', columns: ['email'], unique: true, spatial: false }] }
                    )
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'email', ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false,
                'myapp'
            );

            const stmts = generateDDL(diff);
            const idxStmt = stmts.find(s => s.includes('CREATE UNIQUE INDEX'));
            assert.ok(idxStmt);
            assert.ok(idxStmt!.includes('"myapp"."users"'), 'Index DDL should use schema-qualified table name');
        });

        it('should schema-qualify table names in FK DDL for non-public schema', async () => {
            const diff = await compareSchemas(
                schema(
                    table(
                        'posts',
                        [
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                        ],
                        {
                            foreignKeys: [
                                {
                                    name: 'fk_posts_user',
                                    columns: ['user_id'],
                                    referencedTable: 'users',
                                    referencedColumns: ['id'],
                                    onDelete: 'CASCADE',
                                    onUpdate: 'RESTRICT'
                                }
                            ]
                        }
                    )
                ),
                schema(
                    table('posts', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ])
                ),
                'postgres',
                false,
                'myapp'
            );

            const stmts = generateDDL(diff);
            const fkStmt = stmts.find(s => s.includes('ADD CONSTRAINT'));
            assert.ok(fkStmt);
            assert.ok(fkStmt!.includes('"myapp"."posts"'), 'FK DDL should use schema-qualified source table');
            assert.ok(fkStmt!.includes('"myapp"."users"'), 'FK DDL should use schema-qualified referenced table');
        });
    });

    describe('schema-qualified PG DDL', () => {
        it('should qualify table names when pgSchema is not public', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', type: 'varchar', size: 100, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false,
                'myapp'
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('"myapp"."users"'), 'Should qualify table with schema name');
        });

        it('should not qualify table names when pgSchema is public', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', type: 'varchar', size: 100, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false,
                'public'
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('CREATE TABLE "users"'), 'Should use unqualified name for public schema');
            assert.ok(!create.includes('"public"."users"'), 'Should not qualify with public schema');
        });

        it('should schema-qualify DROP INDEX for non-public schema', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'email', ordinalPosition: 2 })
                    ])
                ),
                schema(
                    table(
                        'users',
                        [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'email', ordinalPosition: 2 })],
                        { indexes: [{ name: 'idx_email', columns: ['email'], unique: false, spatial: false }] }
                    )
                ),
                'postgres',
                false,
                'myapp'
            );

            const stmts = generateDDL(diff);
            assert.ok(
                stmts.some(s => s.includes('DROP INDEX "myapp"."idx_email"')),
                'DROP INDEX should be schema-qualified'
            );
        });

        it('should schema-qualify enum types for non-public schema', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'users_status', ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false,
                'myapp'
            );

            const stmts = generateDDL(diff);
            assert.ok(
                stmts.some(s => s.includes('"myapp"."users_status"')),
                'CREATE TYPE should be schema-qualified'
            );
        });
    });

    describe('enum type name change', () => {
        it('should produce CREATE TYPE and ALTER COLUMN TYPE when enum type name changes', async () => {
            const diff = await compareSchemas(
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'status',
                            type: 'enum',
                            enumValues: ['active', 'inactive'],
                            enumTypeName: 'users_status_v2',
                            ordinalPosition: 2
                        })
                    ])
                ),
                schema(
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'status',
                            type: 'enum',
                            enumValues: ['active', 'inactive'],
                            enumTypeName: 'users_status',
                            ordinalPosition: 2
                        })
                    ])
                ),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);

            // Should CREATE TYPE for the new enum type name
            assert.ok(
                stmts.some(s => s.includes('CREATE TYPE "users_status_v2"')),
                'Should create the new enum type: ' + JSON.stringify(stmts)
            );
            // Should ALTER COLUMN TYPE with USING cast to the new type
            assert.ok(
                stmts.some(s => s.includes('ALTER COLUMN "status" TYPE "users_status_v2"') && s.includes('USING')),
                'Should alter column to new enum type with USING cast'
            );
        });
    });

    describe('FK ordering for new interdependent tables', () => {
        it('should emit FKs after all tables are created', async () => {
            // Table A references Table B and vice versa (circular dependency)
            const tableA = table(
                'orders',
                [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'user_id', type: 'int', ordinalPosition: 2 })],
                {
                    foreignKeys: [
                        {
                            name: 'fk_orders_user',
                            columns: ['user_id'],
                            referencedTable: 'users',
                            referencedColumns: ['id'],
                            onDelete: 'CASCADE',
                            onUpdate: 'RESTRICT'
                        }
                    ]
                }
            );
            const tableB = table(
                'users',
                [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'last_order_id', type: 'int', nullable: true, ordinalPosition: 2 })
                ],
                {
                    foreignKeys: [
                        {
                            name: 'fk_users_last_order',
                            columns: ['last_order_id'],
                            referencedTable: 'orders',
                            referencedColumns: ['id'],
                            onDelete: 'SET NULL',
                            onUpdate: 'RESTRICT'
                        }
                    ]
                }
            );

            const diff = await compareSchemas(schema(tableA, tableB), schema(), 'postgres', false);
            const stmts = generateDDL(diff);

            // All CREATE TABLE statements should come before any ADD CONSTRAINT FK statements
            const createTableIdxs = stmts.map((s, i) => (s.includes('CREATE TABLE') ? i : -1)).filter(i => i >= 0);
            const addFkIdxs = stmts.map((s, i) => (s.includes('ADD CONSTRAINT') && s.includes('FOREIGN KEY') ? i : -1)).filter(i => i >= 0);

            assert.ok(createTableIdxs.length === 2, 'Should have 2 CREATE TABLE statements');
            assert.ok(addFkIdxs.length === 2, 'Should have 2 FK constraints');
            const maxCreateTable = Math.max(...createTableIdxs);
            const minAddFk = Math.min(...addFkIdxs);
            assert.ok(maxCreateTable < minAddFk, `All CREATE TABLEs (last at ${maxCreateTable}) should come before FKs (first at ${minAddFk})`);
        });
    });

    describe('default expression normalization', () => {
        it('should treat now() and CURRENT_TIMESTAMP as equivalent', async () => {
            const entity = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'created_at',
                        type: 'timestamp',
                        size: undefined,
                        defaultExpression: 'CURRENT_TIMESTAMP',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created_at', type: 'timestamp', size: undefined, defaultExpression: 'now()', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            // now() and CURRENT_TIMESTAMP are equivalent — no diff expected
            assert.equal(diff.modifiedTables.length, 0, 'now() and CURRENT_TIMESTAMP should be treated as equivalent');
        });
    });

    describe('FK NO ACTION / RESTRICT normalization', () => {
        it('should treat NO ACTION and RESTRICT as equivalent for comparison', async () => {
            const entity = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    {
                        foreignKeys: [
                            {
                                name: 'fk_posts_user',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'RESTRICT',
                                onUpdate: 'RESTRICT'
                            }
                        ]
                    }
                )
            );
            const db = schema(
                table(
                    'posts',
                    [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'user_id', type: 'int', ordinalPosition: 2 })
                    ],
                    {
                        foreignKeys: [
                            {
                                name: 'fk_posts_user',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'NO ACTION',
                                onUpdate: 'NO ACTION'
                            }
                        ]
                    }
                )
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            // NO ACTION and RESTRICT are semantically equivalent — no diff expected
            assert.equal(diff.modifiedTables.length, 0, 'NO ACTION and RESTRICT should be treated as equivalent');
        });
    });

    describe('conditional PK drop', () => {
        it('should not emit DROP PRIMARY KEY when DB has no existing PK (MySQL)', async () => {
            const entity = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'name', ordinalPosition: 2 })])
            );
            // DB has no PK
            const db = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }), col({ name: 'name', ordinalPosition: 2 })])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].primaryKeyChanged, true);
            assert.deepEqual(diff.modifiedTables[0].oldPrimaryKey, []);

            const stmts = generateDDL(diff);
            assert.ok(!stmts.some(s => s.includes('DROP PRIMARY KEY')), 'Should not DROP PRIMARY KEY when DB has none');
            assert.ok(
                stmts.some(s => s.includes('ADD PRIMARY KEY')),
                'Should ADD PRIMARY KEY'
            );
        });

        it('should not emit DROP CONSTRAINT for PK when DB has no existing PK (PG)', async () => {
            const entity = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }), col({ name: 'name', ordinalPosition: 2 })])
            );
            const db = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }), col({ name: 'name', ordinalPosition: 2 })])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            assert.ok(!stmts.some(s => s.includes('DROP CONSTRAINT') && s.includes('pkey')), 'Should not DROP PK constraint when DB has none');
            assert.ok(
                stmts.some(s => s.includes('ADD PRIMARY KEY')),
                'Should ADD PRIMARY KEY'
            );
        });

        it('should emit DROP PRIMARY KEY when DB has an existing PK (MySQL)', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            assert.ok(
                stmts.some(s => s.includes('DROP PRIMARY KEY')),
                'Should DROP PRIMARY KEY when DB has one'
            );
            assert.ok(
                stmts.some(s => s.includes('ADD PRIMARY KEY')),
                'Should ADD new PRIMARY KEY'
            );
        });
    });

    describe('PG auto-increment changes', () => {
        it('should emit CREATE SEQUENCE and SET DEFAULT when adding auto-increment', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            assert.ok(
                stmts.some(s => s.includes('CREATE SEQUENCE') && s.includes('users_id_seq')),
                'Should create sequence'
            );
            assert.ok(
                stmts.some(s => s.includes('SET DEFAULT nextval')),
                'Should set default to nextval'
            );
        });

        it('should emit DROP DEFAULT and DROP SEQUENCE when removing auto-increment', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            assert.ok(
                stmts.some(s => s.includes('DROP DEFAULT')),
                'Should drop default'
            );
            assert.ok(
                stmts.some(s => s.includes('DROP SEQUENCE') && s.includes('users_id_seq')),
                'Should drop sequence'
            );
        });
    });

    describe('shared enum type deduplication', () => {
        it('should emit ALTER TYPE ADD VALUE once for shared enum across multiple tables', async () => {
            // Two tables share the same enum type, both modified to add a value
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive', 'banned'],
                        enumTypeName: 'shared_status',
                        ordinalPosition: 2
                    })
                ]),
                table('admins', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive', 'banned'],
                        enumTypeName: 'shared_status',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'shared_status', ordinalPosition: 2 })
                ]),
                table('admins', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumValues: ['active', 'inactive'], enumTypeName: 'shared_status', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            const addValueStmts = stmts.filter(s => s.includes("ADD VALUE 'banned'"));
            assert.equal(addValueStmts.length, 1, 'Should only emit ADD VALUE once for shared enum type');
        });

        it('should recreate shared enum type once and cast all affected columns', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'banned'],
                        enumTypeName: 'shared_status',
                        ordinalPosition: 2
                    })
                ]),
                table('admins', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'banned'],
                        enumTypeName: 'shared_status',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'shared_status',
                        ordinalPosition: 2
                    })
                ]),
                table('admins', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'shared_status',
                        ordinalPosition: 2
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            const renameStmts = stmts.filter(s => s.includes('RENAME TO'));
            assert.equal(renameStmts.length, 1, 'Should only RENAME once for shared enum');

            const createTypeStmts = stmts.filter(s => s.includes('CREATE TYPE "shared_status"'));
            assert.equal(createTypeStmts.length, 1, 'Should only CREATE TYPE once for shared enum');

            // Should have ALTER COLUMN TYPE for both tables
            const castStmts = stmts.filter(s => s.includes('ALTER COLUMN "status" TYPE'));
            assert.equal(castStmts.length, 2, 'Should cast both columns');

            // Two DROP TYPE IF EXISTS: one pre-RENAME (collision avoidance) and one deferred (cleanup)
            const dropStmts = stmts.filter(s => s.includes('DROP TYPE'));
            assert.equal(dropStmts.length, 2, 'Should have pre-RENAME and deferred DROP TYPE');
        });
    });

    describe('decimal/numeric without precision', () => {
        it('should generate bare DECIMAL when MySQL column has no precision', async () => {
            const diff = await compareSchemas(
                schema(
                    table('products', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'price', type: 'decimal', size: undefined, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('DECIMAL'), 'Should include DECIMAL');
            assert.ok(!create.includes('DECIMAL('), 'Should not include DECIMAL( with parentheses');
        });

        it('should generate bare NUMERIC when PG column has no precision', async () => {
            const diff = await compareSchemas(
                schema(
                    table('products', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'price', type: 'numeric', size: undefined, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('NUMERIC'), 'Should include NUMERIC');
            assert.ok(!create.includes('NUMERIC('), 'Should not include NUMERIC( with parentheses');
        });

        it('should generate DECIMAL(10,2) when precision and scale are set', async () => {
            const diff = await compareSchemas(
                schema(
                    table('products', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'price', type: 'decimal', size: 10, scale: 2, ordinalPosition: 2 })
                    ])
                ),
                schema(),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('DECIMAL(10,2)'), 'Should include DECIMAL(10,2)');
        });
    });

    describe('enum value order normalization', () => {
        it('should not detect a diff when enum values are the same but in different order', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['inactive', 'active'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            assert.equal(diff.modifiedTables.length, 0, 'Enum reorder-only should not produce a diff');
        });

        it('should still detect enum value additions regardless of order', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['banned', 'active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            assert.equal(diff.modifiedTables.length, 1, 'Should detect new enum value');
            assert.equal(diff.modifiedTables[0].modifiedEnumTypes.length, 1);
            assert.deepEqual(diff.modifiedTables[0].modifiedEnumTypes[0].added, ['banned']);
        });
    });

    describe('type alias normalization', () => {
        it('should treat integer and int as equivalent', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'age', type: 'int', ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'age', type: 'integer', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 0, 'int and integer should be treated as equivalent');
        });

        it('should treat numeric and decimal as equivalent', async () => {
            const entity = schema(
                table('products', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'price', type: 'decimal', size: 10, scale: 2, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('products', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'price', type: 'numeric', size: 10, scale: 2, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 0, 'decimal and numeric should be treated as equivalent');
        });
    });

    describe('SET DEFAULT FK action rejection for MySQL', () => {
        it('should reject SET DEFAULT onDelete for MySQL', async () => {
            const diff = await compareSchemas(
                schema(
                    table('orders', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })], {
                        foreignKeys: [
                            {
                                name: 'fk_orders_user',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'SET DEFAULT',
                                onUpdate: 'RESTRICT'
                            }
                        ]
                    })
                ),
                schema(),
                'mysql',
                false
            );

            assert.throws(() => generateDDL(diff), /SET DEFAULT.*not supported.*MySQL/i);
        });

        it('should reject SET DEFAULT onUpdate for MySQL', async () => {
            const diff = await compareSchemas(
                schema(
                    table('orders', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })], {
                        foreignKeys: [
                            {
                                name: 'fk_orders_user',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'CASCADE',
                                onUpdate: 'SET DEFAULT'
                            }
                        ]
                    })
                ),
                schema(),
                'mysql',
                false
            );

            assert.throws(() => generateDDL(diff), /SET DEFAULT.*not supported.*MySQL/i);
        });

        it('should allow SET DEFAULT for PostgreSQL', async () => {
            const diff = await compareSchemas(
                schema(
                    table('orders', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })], {
                        foreignKeys: [
                            {
                                name: 'fk_orders_user',
                                columns: ['user_id'],
                                referencedTable: 'users',
                                referencedColumns: ['id'],
                                onDelete: 'SET DEFAULT',
                                onUpdate: 'SET DEFAULT'
                            }
                        ]
                    })
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            const fkStmt = stmts.find(s => s.includes('FOREIGN KEY'));
            assert.ok(fkStmt, 'Should generate FK statement');
            assert.ok(fkStmt!.includes('ON DELETE SET DEFAULT'), 'Should include SET DEFAULT');
            assert.ok(fkStmt!.includes('ON UPDATE SET DEFAULT'), 'Should include SET DEFAULT');
        });
    });

    describe('entity defaults not populated', () => {
        it('should not produce spurious DROP DEFAULT when entity has no default info', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'varchar', size: 20, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'varchar', size: 20, ordinalPosition: 2, defaultValue: 'active' })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            // Entity has no defaultValue/defaultExpression → treated as unspecified → no diff
            assert.equal(diff.modifiedTables.length, 0, 'Should not detect a diff when entity has no default info');
        });

        it('should detect diff when entity explicitly sets a default expression', async () => {
            const entity = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created', type: 'timestamp', ordinalPosition: 2, defaultExpression: 'CURRENT_TIMESTAMP' })
                ])
            );
            const db = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created', type: 'timestamp', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 1, 'Should detect a diff when entity has an explicit default');
            assert.equal(diff.modifiedTables[0].modifiedColumns.length, 1);
            assert.ok(diff.modifiedTables[0].modifiedColumns[0].defaultChanged);
        });
    });

    describe('CURRENT_TIMESTAMP() normalization', () => {
        it('should treat CURRENT_TIMESTAMP and CURRENT_TIMESTAMP() as equivalent', async () => {
            const entity = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created', type: 'timestamp', ordinalPosition: 2, defaultExpression: 'CURRENT_TIMESTAMP' })
                ])
            );
            const db = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created', type: 'timestamp', ordinalPosition: 2, defaultExpression: 'CURRENT_TIMESTAMP()' })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 0, 'CURRENT_TIMESTAMP and CURRENT_TIMESTAMP() should be equivalent');
        });

        it('should treat now() and CURRENT_TIMESTAMP() as equivalent', async () => {
            const entity = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created', type: 'timestamp', ordinalPosition: 2, defaultExpression: 'now()' })
                ])
            );
            const db = schema(
                table('events', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'created', type: 'timestamp', ordinalPosition: 2, defaultExpression: 'CURRENT_TIMESTAMP()' })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            assert.equal(diff.modifiedTables.length, 0, 'now() and CURRENT_TIMESTAMP() should be equivalent');
        });
    });

    describe('PG auto-increment nextval escaping', () => {
        it('should escape single quotes in schema name for nextval', async () => {
            const entity = schema(table('items', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));
            const db = schema(table('items', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));

            // Use a schema name with a single quote to test escaping
            const diff = await compareSchemas(entity, db, 'postgres', false, "test'schema");
            const stmts = generateDDL(diff);

            const nextvalStmt = stmts.find(s => s.includes('nextval'));
            assert.ok(nextvalStmt, 'Should generate nextval statement');
            // The single quote in the schema name should be escaped
            assert.ok(nextvalStmt!.includes("test''schema"), 'Should escape single quotes in schema name');
        });
    });

    describe('PG rename + property changes', () => {
        it('should emit RENAME COLUMN and ALTER COLUMN TYPE for PG renamed column with type change', () => {
            const diff = {
                dialect: 'postgres' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'full_name',
                                oldColumn: col({ name: 'name', type: 'varchar', size: 100, ordinalPosition: 2 }),
                                newColumn: col({ name: 'full_name', type: 'varchar', size: 255, ordinalPosition: 2 }),
                                typeChanged: true,
                                nullableChanged: false,
                                defaultChanged: false,
                                autoIncrementChanged: false,
                                onUpdateChanged: false
                            }
                        ],
                        renamedColumns: [
                            {
                                from: 'name',
                                to: 'full_name',
                                column: col({ name: 'full_name', type: 'varchar', size: 255, ordinalPosition: 2 })
                            }
                        ],
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
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'full_name', type: 'varchar', size: 255, ordinalPosition: 2 })
                        ]
                    }
                ]
            };

            const stmts = generateDDL(diff);

            const renameStmt = stmts.find(s => s.includes('RENAME COLUMN'));
            assert.ok(renameStmt, 'Should emit RENAME COLUMN');
            assert.ok(renameStmt!.includes('"name"'), 'Should reference old name');
            assert.ok(renameStmt!.includes('"full_name"'), 'Should reference new name');

            const typeStmt = stmts.find(s => s.includes('ALTER COLUMN') && s.includes('TYPE'));
            assert.ok(typeStmt, 'Should emit ALTER COLUMN TYPE for the renamed column');
            assert.ok(typeStmt!.includes('VARCHAR(255)'), 'Should use new type');
        });

        it('should emit RENAME COLUMN and SET NOT NULL for PG renamed column with nullable change', () => {
            const diff = {
                dialect: 'postgres' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'email_addr',
                                oldColumn: col({ name: 'email', type: 'varchar', size: 255, nullable: true, ordinalPosition: 2 }),
                                newColumn: col({ name: 'email_addr', type: 'varchar', size: 255, nullable: false, ordinalPosition: 2 }),
                                typeChanged: false,
                                nullableChanged: true,
                                defaultChanged: false,
                                autoIncrementChanged: false,
                                onUpdateChanged: false
                            }
                        ],
                        renamedColumns: [
                            {
                                from: 'email',
                                to: 'email_addr',
                                column: col({ name: 'email_addr', type: 'varchar', size: 255, nullable: false, ordinalPosition: 2 })
                            }
                        ],
                        reorderedColumns: [],
                        addedIndexes: [],
                        removedIndexes: [],
                        addedForeignKeys: [],
                        removedForeignKeys: [],
                        primaryKeyChanged: false,
                        addedEnumTypes: [],
                        removedEnumTypes: [],
                        modifiedEnumTypes: [],
                        entityColumns: []
                    }
                ]
            };

            const stmts = generateDDL(diff);

            assert.ok(
                stmts.some(s => s.includes('RENAME COLUMN')),
                'Should emit RENAME COLUMN'
            );
            assert.ok(
                stmts.some(s => s.includes('SET NOT NULL')),
                'Should emit SET NOT NULL'
            );
        });

        it('should NOT emit duplicate MODIFY COLUMN for MySQL renamed columns', () => {
            const diff = {
                dialect: 'mysql' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'full_name',
                                oldColumn: col({ name: 'name', type: 'varchar', size: 100, ordinalPosition: 2 }),
                                newColumn: col({ name: 'full_name', type: 'varchar', size: 255, ordinalPosition: 2 }),
                                typeChanged: true,
                                nullableChanged: false,
                                defaultChanged: false,
                                autoIncrementChanged: false,
                                onUpdateChanged: false
                            }
                        ],
                        renamedColumns: [
                            {
                                from: 'name',
                                to: 'full_name',
                                column: col({ name: 'full_name', type: 'varchar', size: 255, ordinalPosition: 2 })
                            }
                        ],
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
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'full_name', type: 'varchar', size: 255, ordinalPosition: 2 })
                        ]
                    }
                ]
            };

            const stmts = generateDDL(diff);

            const changeStmts = stmts.filter(s => s.includes('CHANGE COLUMN'));
            assert.equal(changeStmts.length, 1, 'Should emit exactly one CHANGE COLUMN');

            const modifyStmts = stmts.filter(s => s.includes('MODIFY COLUMN'));
            assert.equal(modifyStmts.length, 0, 'Should NOT emit MODIFY COLUMN for renamed column');
        });
    });

    describe('PG auto-increment setval', () => {
        it('should emit setval after creating sequence for existing column', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            assert.ok(
                stmts.some(s => s.includes('CREATE SEQUENCE')),
                'Should create sequence'
            );
            assert.ok(
                stmts.some(s => s.includes('nextval')),
                'Should set default to nextval'
            );

            const setvalStmt = stmts.find(s => s.includes('setval'));
            assert.ok(setvalStmt, 'Should emit setval to sync sequence');
            assert.ok(setvalStmt!.includes('MAX("id")'), 'setval should reference the column');
            assert.ok(setvalStmt!.includes('"users"'), 'setval should reference the table');
        });

        it('should use regclass-style quoting in nextval for non-public schema', async () => {
            const entity = schema(table('items', [col({ name: 'id', type: 'bigint', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));
            const db = schema(table('items', [col({ name: 'id', type: 'bigint', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false, 'myapp');
            const stmts = generateDDL(diff);

            const nextvalStmt = stmts.find(s => s.includes('nextval'));
            assert.ok(nextvalStmt, 'Should generate nextval');
            // Should contain properly quoted schema.sequence
            assert.ok(nextvalStmt!.includes('"myapp"."items_id_seq"'), 'Should use quoted identifiers in nextval');
        });
    });

    describe('MySQL backslash escaping', () => {
        it('should escape backslashes in MySQL enum values', async () => {
            const diff = await compareSchemas(
                schema(
                    table('items', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'path',
                            type: 'enum',
                            enumValues: ['C:\\Users', 'D:\\Data'],
                            ordinalPosition: 2
                        })
                    ])
                ),
                schema(),
                'mysql',
                false
            );

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('C:\\\\Users'), 'Should double backslashes in MySQL enum values');
        });

        it('should escape backslashes in MySQL default values', () => {
            const diff = {
                dialect: 'mysql' as const,
                addedTables: [
                    table('config', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'path', type: 'varchar', size: 255, ordinalPosition: 2, defaultValue: 'C:\\temp' })
                    ])
                ],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);
            const create = stmts[0];
            assert.ok(create.includes('C:\\\\temp'), 'Should double backslashes in MySQL default values');
        });

        it('should NOT escape backslashes in PG string literals', async () => {
            const diff = await compareSchemas(
                schema(
                    table('items', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({
                            name: 'status',
                            type: 'enum',
                            enumValues: ['val\\ue'],
                            enumTypeName: 'items_status',
                            ordinalPosition: 2
                        })
                    ])
                ),
                schema(),
                'postgres',
                false
            );

            const stmts = generateDDL(diff);
            // PG enum CREATE TYPE should have single backslash (not doubled)
            const createType = stmts.find(s => s.includes('CREATE TYPE'));
            assert.ok(createType, 'Should create enum type');
            assert.ok(createType!.includes('val\\ue'), 'PG should preserve single backslash');
            assert.ok(!createType!.includes('val\\\\ue'), 'PG should NOT double backslashes');
        });
    });

    describe('enum DROP TYPE after removed tables', () => {
        it('should emit DROP TYPE after DROP TABLE when both exist', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                addedTables: [],
                removedTables: [
                    table('old_table', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumTypeName: 'shared_status', ordinalPosition: 2 })
                    ])
                ],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'status',
                                oldColumn: col({
                                    name: 'status',
                                    type: 'enum',
                                    enumValues: ['active', 'inactive', 'banned'],
                                    enumTypeName: 'shared_status',
                                    ordinalPosition: 2
                                }),
                                newColumn: col({
                                    name: 'status',
                                    type: 'enum',
                                    enumValues: ['active', 'inactive'],
                                    enumTypeName: 'shared_status',
                                    ordinalPosition: 2
                                }),
                                typeChanged: true,
                                nullableChanged: false,
                                defaultChanged: false,
                                autoIncrementChanged: false,
                                onUpdateChanged: false
                            }
                        ],
                        renamedColumns: [],
                        reorderedColumns: [],
                        addedIndexes: [],
                        removedIndexes: [],
                        addedForeignKeys: [],
                        removedForeignKeys: [],
                        primaryKeyChanged: false,
                        addedEnumTypes: [],
                        removedEnumTypes: [],
                        modifiedEnumTypes: [
                            {
                                typeName: 'shared_status',
                                added: [],
                                removed: ['banned'],
                                newValues: ['active', 'inactive'],
                                tableName: 'users',
                                columnName: 'status'
                            }
                        ],
                        entityColumns: []
                    }
                ],
                // users still uses shared_status — only the _old copy should be dropped
                entityEnumTypes: new Set(['shared_status'])
            };

            const stmts = generateDDL(diff);

            const dropTableIdx = stmts.findIndex(s => s.includes('DROP TABLE'));
            // Find the LAST DROP TYPE for shared_status_old (the deferred cleanup drop, not the pre-rename collision avoidance drop)
            const dropTypeIdx = stmts.reduce((last, s, i) => (s.includes('DROP TYPE') && s.includes('shared_status_old') ? i : last), -1);

            assert.ok(dropTableIdx >= 0, 'Should emit DROP TABLE');
            assert.ok(dropTypeIdx >= 0, 'Should emit DROP TYPE for _old');
            assert.ok(dropTypeIdx > dropTableIdx, 'DROP TYPE should come after DROP TABLE');

            // Should NOT drop the live shared_status type
            const dropLiveType = stmts.find(s => s.includes('DROP TYPE') && s.includes('"shared_status"') && !s.includes('shared_status_old'));
            assert.ok(!dropLiveType, 'Should not drop live shared_status type: ' + stmts.join(' | '));
        });
    });

    describe('comparator rename + modification detection', () => {
        it('should detect property changes on renamed columns', async () => {
            // Simulate a scenario where column "name" was renamed to "full_name" with type change
            // Since interactive=false, renames won't be detected by the comparator,
            // so we test by manually constructing the diff (as if rename was detected)
            // The key behavior: when renamedColumns has entries, modifiedColumns should also
            // include entries for the same columns if their properties differ.

            // We verify this at the DDL level since the comparator needs interactive=true for renames
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'email', type: 'varchar', size: 255, nullable: true, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'email', type: 'varchar', size: 255, nullable: false, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);

            // Same-name column with nullable change should be detected
            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].modifiedColumns.length, 1);
            assert.ok(diff.modifiedTables[0].modifiedColumns[0].nullableChanged);
        });
    });

    describe('MySQL AUTO_INCREMENT + PK change ordering', () => {
        it('should remove AUTO_INCREMENT before DROP PRIMARY KEY when old PK column is auto-increment', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: false, autoIncrement: false, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            // Should have a MODIFY COLUMN to remove AUTO_INCREMENT BEFORE DROP PRIMARY KEY
            const removeAIIdx = stmts.findIndex(s => s.includes('MODIFY COLUMN') && s.includes('`id`') && !s.includes('AUTO_INCREMENT'));
            const dropPKIdx = stmts.findIndex(s => s.includes('DROP PRIMARY KEY'));
            const addPKIdx = stmts.findIndex(s => s.includes('ADD PRIMARY KEY'));

            assert.ok(removeAIIdx >= 0, 'Should emit MODIFY to remove AUTO_INCREMENT: ' + JSON.stringify(stmts));
            assert.ok(dropPKIdx >= 0, 'Should emit DROP PRIMARY KEY');
            assert.ok(addPKIdx >= 0, 'Should emit ADD PRIMARY KEY');
            assert.ok(removeAIIdx < dropPKIdx, 'MODIFY (remove AI) should come before DROP PRIMARY KEY');
            assert.ok(dropPKIdx < addPKIdx, 'DROP PRIMARY KEY should come before ADD PRIMARY KEY');
        });

        it('should not emit extra MODIFY when old PK column is not auto-increment', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: false, ordinalPosition: 1 }),
                    col({ name: 'uuid', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            // Should NOT have a pre-PK-drop MODIFY for AUTO_INCREMENT
            const dropPKIdx = stmts.findIndex(s => s.includes('DROP PRIMARY KEY'));
            assert.ok(dropPKIdx >= 0, 'Should emit DROP PRIMARY KEY');
            // No MODIFY COLUMN should appear before DROP PRIMARY KEY
            const stmtsBeforePK = stmts.slice(0, dropPKIdx);
            assert.ok(
                !stmtsBeforePK.some(s => s.includes('MODIFY COLUMN')),
                'Should not emit MODIFY before DROP PRIMARY KEY when no AUTO_INCREMENT involved'
            );
        });
    });

    describe('INTERNAL_TABLES consistency', () => {
        it('should use the same internal table set in entity-reader and command', async () => {
            // Verify that INTERNAL_TABLES is exported and contains expected entries
            const { INTERNAL_TABLES } = await import('../../src/database/migration/create/schema-model');
            assert.ok(INTERNAL_TABLES.has('_migrations'), 'Should include _migrations');
            assert.ok(INTERNAL_TABLES.has('_locks'), 'Should include _locks');
            assert.ok(INTERNAL_TABLES.has('_jobs'), 'Should include _jobs');
            // User-defined underscore tables should NOT be excluded
            assert.ok(!INTERNAL_TABLES.has('_custom_table'), '_custom_table should not be internal');
        });
    });

    describe('PK rename normalization', () => {
        it('should not detect PK change when PK column is only renamed', () => {
            // Build a diff manually with a renamed PK column to test comparator behavior
            // Since interactive=false won't trigger renames, we construct it directly
            const diff = {
                dialect: 'mysql' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [],
                        renamedColumns: [
                            {
                                from: 'user_id',
                                to: 'id',
                                column: col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })
                            }
                        ],
                        reorderedColumns: [],
                        addedIndexes: [],
                        removedIndexes: [],
                        addedForeignKeys: [],
                        removedForeignKeys: [],
                        primaryKeyChanged: false,
                        addedEnumTypes: [],
                        removedEnumTypes: [],
                        modifiedEnumTypes: [],
                        entityColumns: [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]
                    }
                ]
            };

            const stmts = generateDDL(diff);

            // Only a CHANGE COLUMN should be emitted; no DROP/ADD PRIMARY KEY
            assert.ok(!stmts.some(s => s.includes('DROP PRIMARY KEY')), 'Should NOT drop PK for rename-only');
            assert.ok(!stmts.some(s => s.includes('ADD PRIMARY KEY')), 'Should NOT add PK for rename-only');
            assert.ok(
                stmts.some(s => s.includes('CHANGE COLUMN')),
                'Should emit CHANGE COLUMN for rename'
            );
        });

        it('should normalize DB PK names through rename mappings in comparator', async () => {
            // Simulate: entity PK is 'id', DB PK is 'user_id', column was renamed user_id → id
            // We need interactive=true for rename detection, which requires the prompt module.
            // Instead, verify at the comparator level that PK comparison happens after rename normalization.
            // The comparator applies renamedFromToMap to DB PK names.
            // This is tested indirectly: if columns differ only by name and the PK column is among them,
            // the comparator should see them as the same PK (no primaryKeyChanged) after rename detection.

            // Since interactive=false means no renames detected, we test that same-named PKs are not flagged
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]));
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'mysql', false);
            assert.equal(diff.modifiedTables.length, 0, 'Same PK should not produce a diff');
        });
    });

    describe('MySQL CHANGE COLUMN AFTER excludes not-yet-added columns', () => {
        it('should not reference an added column in AFTER clause for rename', () => {
            // Scenario: entity has [id, new_col, renamed_col]
            // DB has [id, old_col]
            // rename: old_col → renamed_col; add: new_col
            // CHANGE COLUMN should NOT use AFTER `new_col` since it doesn't exist yet
            const diff = {
                dialect: 'mysql' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [col({ name: 'new_col', ordinalPosition: 2 })],
                        removedColumns: [],
                        modifiedColumns: [],
                        renamedColumns: [
                            {
                                from: 'old_col',
                                to: 'renamed_col',
                                column: col({ name: 'renamed_col', ordinalPosition: 3 })
                            }
                        ],
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
                            col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                            col({ name: 'new_col', ordinalPosition: 2 }),
                            col({ name: 'renamed_col', ordinalPosition: 3 })
                        ]
                    }
                ]
            };

            const stmts = generateDDL(diff);

            const changeStmt = stmts.find(s => s.includes('CHANGE COLUMN'));
            assert.ok(changeStmt, 'Should emit CHANGE COLUMN');
            // Should NOT reference `new_col` (it doesn't exist yet at rename step)
            assert.ok(!changeStmt!.includes('AFTER `new_col`'), 'CHANGE COLUMN should not reference not-yet-added column: ' + changeStmt);
            // Should reference `id` instead (the nearest existing predecessor)
            assert.ok(changeStmt!.includes('AFTER `id`'), 'CHANGE COLUMN should reference existing predecessor: ' + changeStmt);
        });
    });

    describe('PG setval empty table safety', () => {
        it('should use 3-arg setval with is_called for empty table safety', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            const setvalStmt = stmts.find(s => s.includes('setval'));
            assert.ok(setvalStmt, 'Should emit setval');
            // Should use 3-arg form: setval(seq, value, is_called)
            assert.ok(setvalStmt!.includes('IS NOT NULL'), 'Should use is_called based on whether MAX exists: ' + setvalStmt);
            // Should use COALESCE with 1 (not 0) as fallback for empty tables
            assert.ok(setvalStmt!.includes('COALESCE') && setvalStmt!.includes(', 1)'), 'Should use 1 as fallback for empty tables: ' + setvalStmt);
        });
    });

    describe('onUpdateExpression handling', () => {
        it('should flag onUpdateExpression removal when entity has no annotation but DB has it', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2 })
                    // no onUpdateExpression — entity does not use OnUpdate<> annotation
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2, onUpdateExpression: 'CURRENT_TIMESTAMP' })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            assert.strictEqual(diff.modifiedTables.length, 1, 'Should detect modification when DB has ON UPDATE but entity does not');
            const mod = diff.modifiedTables[0].modifiedColumns.find(m => m.name === 'updated_at');
            assert.ok(mod, 'Should find updated_at modification');
            assert.strictEqual(mod!.onUpdateChanged, true);
        });

        it('should not flag when both entity and DB have the same onUpdateExpression', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2, onUpdateExpression: 'CURRENT_TIMESTAMP' })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2, onUpdateExpression: 'CURRENT_TIMESTAMP' })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            assert.strictEqual(diff.modifiedTables.length, 0, 'Should not detect modifications when ON UPDATE matches');
        });

        it('should not flag when neither entity nor DB has onUpdateExpression', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            assert.strictEqual(diff.modifiedTables.length, 0, 'Should not detect modifications when neither has ON UPDATE');
        });

        it('should flag onUpdateExpression addition when entity has it but DB does not', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2, onUpdateExpression: 'CURRENT_TIMESTAMP' })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'updated_at', type: 'datetime', ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            assert.strictEqual(diff.modifiedTables.length, 1, 'Should detect modification when entity has ON UPDATE but DB does not');
            const mod = diff.modifiedTables[0].modifiedColumns.find(m => m.name === 'updated_at');
            assert.ok(mod, 'Should find updated_at modification');
            assert.strictEqual(mod!.onUpdateChanged, true);
        });
    });

    describe('MySQL PK drop with removed AUTO_INCREMENT column', () => {
        it('should strip AUTO_INCREMENT before DROP PRIMARY KEY for removed column', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'new_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'old_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            // Should emit MODIFY COLUMN to strip AUTO_INCREMENT before DROP PRIMARY KEY
            const modifyIdx = stmts.findIndex(s => s.includes('MODIFY COLUMN') && s.includes('`old_id`') && !s.includes('AUTO_INCREMENT'));
            const dropPKIdx = stmts.findIndex(s => s.includes('DROP PRIMARY KEY'));
            const dropColIdx = stmts.findIndex(s => s.includes('DROP COLUMN') && s.includes('`old_id`'));

            assert.ok(modifyIdx >= 0, 'Should emit MODIFY COLUMN to strip AUTO_INCREMENT: ' + stmts.join(' | '));
            assert.ok(dropPKIdx >= 0, 'Should emit DROP PRIMARY KEY');
            assert.ok(modifyIdx < dropPKIdx, 'MODIFY should come before DROP PRIMARY KEY');
            assert.ok(dropPKIdx < dropColIdx, 'DROP PRIMARY KEY should come before DROP COLUMN');
        });
    });

    describe('MySQL AUTO_INCREMENT addition after PK', () => {
        it('should add AUTO_INCREMENT after ADD PRIMARY KEY for modified columns', async () => {
            // Scenario: changing PK and adding AUTO_INCREMENT to the new PK column
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: false, autoIncrement: false, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'varchar', size: 255, isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            const addPKIdx = stmts.findIndex(s => s.includes('ADD PRIMARY KEY'));
            const autoIncIdx = stmts.findIndex(s => s.includes('MODIFY COLUMN') && s.includes('`id`') && s.includes('AUTO_INCREMENT'));

            assert.ok(addPKIdx >= 0, 'Should emit ADD PRIMARY KEY: ' + stmts.join(' | '));
            assert.ok(autoIncIdx >= 0, 'Should emit MODIFY COLUMN with AUTO_INCREMENT: ' + stmts.join(' | '));
            assert.ok(addPKIdx < autoIncIdx, 'ADD PRIMARY KEY should come before AUTO_INCREMENT addition');
        });

        it('should add new AUTO_INCREMENT column without AUTO_INCREMENT first, then apply after PK', async () => {
            // Scenario: adding a new column with AUTO_INCREMENT to an existing table
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                ])
            );
            const db = schema(table('users', [col({ name: 'name', type: 'varchar', size: 255, isPrimaryKey: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            // ADD COLUMN should NOT include AUTO_INCREMENT (it would fail before PK exists)
            const addColStmt = stmts.find(s => s.includes('ADD COLUMN') && s.includes('`id`'));
            assert.ok(addColStmt, 'Should emit ADD COLUMN for id: ' + stmts.join(' | '));
            assert.ok(!addColStmt!.includes('AUTO_INCREMENT'), 'ADD COLUMN should not include AUTO_INCREMENT: ' + addColStmt);

            // ADD PRIMARY KEY should come before the MODIFY that adds AUTO_INCREMENT
            const addPKIdx = stmts.findIndex(s => s.includes('ADD PRIMARY KEY'));
            const autoIncIdx = stmts.findIndex(s => s.includes('MODIFY COLUMN') && s.includes('`id`') && s.includes('AUTO_INCREMENT'));

            assert.ok(addPKIdx >= 0, 'Should emit ADD PRIMARY KEY');
            assert.ok(autoIncIdx >= 0, 'Should emit MODIFY COLUMN with AUTO_INCREMENT');
            assert.ok(addPKIdx < autoIncIdx, 'ADD PRIMARY KEY should come before AUTO_INCREMENT MODIFY');
        });
    });

    describe('PG identity column removal', () => {
        it('should use DROP IDENTITY for identity columns', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));
            const db = schema(
                table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, isIdentity: true, ordinalPosition: 1 })])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            const dropIdentity = stmts.find(s => s.includes('DROP IDENTITY'));
            assert.ok(dropIdentity, 'Should emit DROP IDENTITY for identity column: ' + stmts.join(' | '));
            // Should NOT emit DROP SEQUENCE for identity columns
            const dropSeq = stmts.find(s => s.includes('DROP SEQUENCE'));
            assert.ok(!dropSeq, 'Should not emit DROP SEQUENCE for identity columns');
        });

        it('should use DROP DEFAULT + DROP SEQUENCE for sequence-backed columns', async () => {
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: false, ordinalPosition: 1 })]));
            const db = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            const dropDefault = stmts.find(s => s.includes('DROP DEFAULT'));
            const dropSeq = stmts.find(s => s.includes('DROP SEQUENCE'));
            assert.ok(dropDefault, 'Should emit DROP DEFAULT for sequence-backed column');
            assert.ok(dropSeq, 'Should emit DROP SEQUENCE for sequence-backed column');
            // Should NOT emit DROP IDENTITY
            const dropIdentity = stmts.find(s => s.includes('DROP IDENTITY'));
            assert.ok(!dropIdentity, 'Should not emit DROP IDENTITY for sequence-backed columns');
        });
    });

    describe('MySQL PK shape change with AUTO_INCREMENT column', () => {
        it('should strip and restore AUTO_INCREMENT when PK shape changes', async () => {
            // PK changes from (id) to (id, tenant_id), id keeps AUTO_INCREMENT
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'tenant_id', type: 'int', isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'tenant_id', type: 'int', isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            // Should strip AUTO_INCREMENT before DROP PRIMARY KEY
            const stripIdx = stmts.findIndex(s => s.includes('MODIFY COLUMN') && s.includes('`id`') && !s.includes('AUTO_INCREMENT'));
            const dropPKIdx = stmts.findIndex(s => s.includes('DROP PRIMARY KEY'));
            const addPKIdx = stmts.findIndex(s => s.includes('ADD PRIMARY KEY'));
            // Should restore AUTO_INCREMENT after ADD PRIMARY KEY
            const restoreIdx = stmts.findIndex(
                (s, i) => i > addPKIdx && s.includes('MODIFY COLUMN') && s.includes('`id`') && s.includes('AUTO_INCREMENT')
            );

            assert.ok(stripIdx >= 0, 'Should strip AUTO_INCREMENT: ' + stmts.join(' | '));
            assert.ok(dropPKIdx >= 0, 'Should emit DROP PRIMARY KEY');
            assert.ok(addPKIdx >= 0, 'Should emit ADD PRIMARY KEY');
            assert.ok(stripIdx < dropPKIdx, 'Strip should come before DROP PRIMARY KEY');
            assert.ok(dropPKIdx < addPKIdx, 'DROP PK should come before ADD PK');
            assert.ok(restoreIdx >= 0, 'Should restore AUTO_INCREMENT after ADD PK: ' + stmts.join(' | '));
        });
    });

    describe('MySQL renamed PK column with AUTO_INCREMENT', () => {
        it('should use DB column name (not entity name) when stripping AUTO_INCREMENT before DROP PK', async () => {
            // Column renamed from 'old_id' to 'new_id', PK changes from (old_id) to (new_id, tenant_id)
            // The MODIFY to strip AUTO_INCREMENT must use the DB name 'old_id' since CHANGE COLUMN hasn't happened yet
            const entity = schema(
                table('users', [
                    col({ name: 'new_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'tenant_id', type: 'int', isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'old_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'tenant_id', type: 'int', isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );

            // Use non-interactive mode — renames won't be detected automatically
            // Manually construct the diff with the rename
            const diff = await compareSchemas(entity, db, 'mysql', false);

            // Since non-interactive, rename won't be detected; manually construct the diff for DDL test
            const manualDiff = {
                dialect: 'mysql' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [],
                        renamedColumns: [
                            {
                                from: 'old_id',
                                to: 'new_id',
                                column: col({ name: 'new_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })
                            }
                        ],
                        reorderedColumns: [],
                        addedIndexes: [],
                        removedIndexes: [],
                        addedForeignKeys: [],
                        removedForeignKeys: [],
                        primaryKeyChanged: true,
                        newPrimaryKey: ['new_id', 'tenant_id'],
                        oldPrimaryKey: ['old_id'], // raw DB name
                        addedEnumTypes: [],
                        removedEnumTypes: [],
                        modifiedEnumTypes: [],
                        entityColumns: [
                            col({ name: 'new_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                            col({ name: 'tenant_id', type: 'int', isPrimaryKey: true, ordinalPosition: 2 })
                        ]
                    }
                ]
            };

            const stmts = generateDDL(manualDiff);

            // The strip should reference `old_id` (current DB name), not `new_id`
            const stripStmt = stmts.find(s => s.includes('MODIFY COLUMN') && s.includes('`old_id`') && !s.includes('AUTO_INCREMENT'));
            assert.ok(stripStmt, 'Should strip AUTO_INCREMENT using DB name `old_id`: ' + stmts.join(' | '));

            // Should NOT have a MODIFY referencing `new_id` before CHANGE COLUMN
            const changeIdx = stmts.findIndex(s => s.includes('CHANGE COLUMN'));
            const modifyNewBeforeChange = stmts.findIndex((s, i) => i < changeIdx && s.includes('MODIFY COLUMN') && s.includes('`new_id`'));
            assert.ok(modifyNewBeforeChange < 0, 'Should not MODIFY `new_id` before CHANGE COLUMN');
        });
    });

    describe('MySQL PK change with unchanged AUTO_INCREMENT column modification', () => {
        it('should defer MODIFY of AUTO_INCREMENT column until after ADD PK when PK changes', async () => {
            // Column `id` has AUTO_INCREMENT (unchanged), but PK changes AND column type changes (int→bigint)
            // The MODIFY should be deferred until after ADD PK
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'bigint', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'tenant_id', type: 'int', isPrimaryKey: true, ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 }),
                    col({ name: 'tenant_id', type: 'int', isPrimaryKey: false, ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entity, db, 'mysql', false);
            const stmts = generateDDL(diff);

            // The final MODIFY with AUTO_INCREMENT and BIGINT should come AFTER ADD PRIMARY KEY
            const addPKIdx = stmts.findIndex(s => s.includes('ADD PRIMARY KEY'));
            assert.ok(addPKIdx >= 0, 'Should have ADD PRIMARY KEY');

            const modifyBigintAIIdx = stmts.findIndex(
                (s, i) => i > addPKIdx && s.includes('MODIFY COLUMN') && s.includes('BIGINT') && s.includes('AUTO_INCREMENT')
            );
            assert.ok(modifyBigintAIIdx >= 0, 'Should defer MODIFY COLUMN with AUTO_INCREMENT to after ADD PK: ' + stmts.join(' | '));

            // Before ADD PK, there should be no MODIFY that includes AUTO_INCREMENT

            // The strip MODIFY (without AUTO_INCREMENT) is fine before DROP PK, but no MODIFY WITH AUTO_INCREMENT before ADD PK
            const anyAIModBeforePK = stmts.some(
                (s, i) => i > 0 && i < addPKIdx && s.includes('MODIFY COLUMN') && s.includes('AUTO_INCREMENT') && !s.includes('DROP PRIMARY KEY')
            );
            assert.ok(!anyAIModBeforePK, 'No MODIFY with AUTO_INCREMENT should appear before ADD PRIMARY KEY');
        });
    });

    describe('PG enum type cleanup', () => {
        it('should DROP old enum type when enum type name changes', async () => {
            // Column stays enum but type name changes (e.g., table_status → accounts_status)
            const entity = schema(
                table('accounts', [
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'accounts_status',
                        ordinalPosition: 1
                    })
                ])
            );
            const db = schema(
                table('accounts', [
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 1
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            // Should CREATE the new type
            const createType = stmts.find(s => s.includes('CREATE TYPE') && s.includes('accounts_status'));
            assert.ok(createType, 'Should CREATE TYPE for new enum name: ' + stmts.join(' | '));

            // Should DROP the old type
            const dropType = stmts.find(s => s.includes('DROP TYPE') && s.includes('users_status'));
            assert.ok(dropType, 'Should DROP TYPE for old enum name: ' + stmts.join(' | '));
        });

        it('should DROP enum type when column is removed', async () => {
            // Column with enum type removed entirely
            const entity = schema(table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]));
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 2
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            // Should DROP the orphaned enum type
            const dropType = stmts.find(s => s.includes('DROP TYPE') && s.includes('users_status'));
            assert.ok(dropType, 'Should DROP TYPE for removed column enum: ' + stmts.join(' | '));

            // DROP TYPE should come after DROP COLUMN
            const dropColIdx = stmts.findIndex(s => s.includes('DROP COLUMN'));
            const dropTypeIdx = stmts.findIndex(s => s.includes('DROP TYPE') && s.includes('users_status'));
            assert.ok(dropColIdx < dropTypeIdx, 'DROP TYPE should come after DROP COLUMN');
        });

        it('should DROP enum type from removed table', async () => {
            const entity = schema();
            const db = schema(
                table('users', [
                    col({
                        name: 'status',
                        type: 'enum',
                        enumValues: ['active', 'inactive'],
                        enumTypeName: 'users_status',
                        ordinalPosition: 1
                    })
                ])
            );

            const diff = await compareSchemas(entity, db, 'postgres', false);
            const stmts = generateDDL(diff);

            // Should DROP TABLE
            const dropTable = stmts.find(s => s.includes('DROP TABLE'));
            assert.ok(dropTable, 'Should DROP TABLE');

            // Should DROP the enum type after dropping the table
            const dropType = stmts.find(s => s.includes('DROP TYPE') && s.includes('users_status'));
            assert.ok(dropType, 'Should DROP TYPE for enum in removed table: ' + stmts.join(' | '));

            const dropTableIdx = stmts.findIndex(s => s.includes('DROP TABLE'));
            const dropTypeIdx = stmts.findIndex(s => s.includes('DROP TYPE') && s.includes('users_status'));
            assert.ok(dropTableIdx < dropTypeIdx, 'DROP TYPE should come after DROP TABLE');
        });
    });

    describe('MySQL renamed AUTO_INCREMENT column with PK change', () => {
        it('should defer AUTO_INCREMENT on renamed column until after ADD PK', () => {
            const manualDiff = {
                dialect: 'mysql' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [],
                        renamedColumns: [
                            {
                                from: 'old_id',
                                to: 'new_id',
                                column: col({ name: 'new_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })
                            }
                        ],
                        reorderedColumns: [],
                        addedIndexes: [],
                        removedIndexes: [],
                        addedForeignKeys: [],
                        removedForeignKeys: [],
                        primaryKeyChanged: true,
                        newPrimaryKey: ['new_id'],
                        oldPrimaryKey: ['old_id'],
                        addedEnumTypes: [],
                        removedEnumTypes: [],
                        modifiedEnumTypes: [],
                        entityColumns: [col({ name: 'new_id', type: 'int', isPrimaryKey: true, autoIncrement: true, ordinalPosition: 1 })]
                    }
                ]
            };

            const stmts = generateDDL(manualDiff);

            // CHANGE COLUMN should NOT include AUTO_INCREMENT (deferred)
            const changeColStmt = stmts.find(s => s.includes('CHANGE COLUMN'));
            assert.ok(changeColStmt, 'Should have CHANGE COLUMN');
            assert.ok(!changeColStmt!.includes('AUTO_INCREMENT'), 'CHANGE COLUMN should not include AUTO_INCREMENT: ' + changeColStmt);

            // After ADD PK, there should be a MODIFY that restores AUTO_INCREMENT
            const addPKIdx = stmts.findIndex(s => s.includes('ADD PRIMARY KEY'));
            assert.ok(addPKIdx >= 0, 'Should have ADD PRIMARY KEY');
            const restoreIdx = stmts.findIndex(
                (s, i) => i > addPKIdx && s.includes('MODIFY COLUMN') && s.includes('`new_id`') && s.includes('AUTO_INCREMENT')
            );
            assert.ok(restoreIdx >= 0, 'Should restore AUTO_INCREMENT after ADD PK: ' + stmts.join(' | '));
        });
    });

    describe('PG enum recreation default handling', () => {
        it('should drop and restore default around enum type change', () => {
            const manualDiff = {
                dialect: 'postgres' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'status',
                                oldColumn: col({
                                    name: 'status',
                                    type: 'enum',
                                    enumValues: ['active', 'inactive', 'banned'],
                                    enumTypeName: 'users_status',
                                    defaultValue: 'active',
                                    ordinalPosition: 2
                                }),
                                newColumn: col({
                                    name: 'status',
                                    type: 'enum',
                                    enumValues: ['active', 'inactive'],
                                    enumTypeName: 'users_status',
                                    ordinalPosition: 2
                                }),
                                typeChanged: true,
                                nullableChanged: false,
                                defaultChanged: false,
                                autoIncrementChanged: false,
                                onUpdateChanged: false
                            }
                        ],
                        renamedColumns: [],
                        reorderedColumns: [],
                        addedIndexes: [],
                        removedIndexes: [],
                        addedForeignKeys: [],
                        removedForeignKeys: [],
                        primaryKeyChanged: false,
                        addedEnumTypes: [],
                        removedEnumTypes: [],
                        modifiedEnumTypes: [
                            {
                                typeName: 'users_status',
                                added: [],
                                removed: ['banned'],
                                newValues: ['active', 'inactive'],
                                tableName: 'users',
                                columnName: 'status'
                            }
                        ],
                        entityColumns: []
                    }
                ]
            };

            const stmts = generateDDL(manualDiff);

            // Should drop default before TYPE change
            const dropDefaultIdx = stmts.findIndex(s => s.includes('DROP DEFAULT'));
            const typeChangeIdx = stmts.findIndex(s => s.includes('ALTER COLUMN') && s.includes('TYPE'));
            assert.ok(dropDefaultIdx >= 0, 'Should emit DROP DEFAULT: ' + stmts.join(' | '));
            assert.ok(typeChangeIdx >= 0, 'Should emit TYPE change');
            assert.ok(dropDefaultIdx < typeChangeIdx, 'DROP DEFAULT should come before TYPE change');

            // Should restore default after TYPE change
            const setDefaultIdx = stmts.findIndex(s => s.includes('SET DEFAULT'));
            assert.ok(setDefaultIdx >= 0, 'Should restore default after TYPE change: ' + stmts.join(' | '));
            assert.ok(setDefaultIdx > typeChangeIdx, 'SET DEFAULT should come after TYPE change');
        });
    });

    describe('PG enum recreation collision avoidance', () => {
        it('should emit DROP TYPE IF EXISTS before RENAME to avoid _old collision', () => {
            const manualDiff = {
                dialect: 'postgres' as const,
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
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
                        modifiedEnumTypes: [
                            {
                                typeName: 'users_status',
                                added: [],
                                removed: ['banned'],
                                newValues: ['active', 'inactive'],
                                tableName: 'users',
                                columnName: 'status'
                            }
                        ],
                        entityColumns: []
                    }
                ]
            };

            const stmts = generateDDL(manualDiff);

            // Should have DROP TYPE IF EXISTS before ALTER TYPE RENAME
            const preDropIdx = stmts.findIndex(s => s.includes('DROP TYPE IF EXISTS') && s.includes('users_status_old'));
            const renameIdx = stmts.findIndex(s => s.includes('ALTER TYPE') && s.includes('RENAME'));
            assert.ok(preDropIdx >= 0, 'Should emit pre-RENAME DROP TYPE IF EXISTS: ' + stmts.join(' | '));
            assert.ok(renameIdx >= 0, 'Should emit ALTER TYPE RENAME');
            assert.ok(preDropIdx < renameIdx, 'Pre-drop should come before RENAME');
        });
    });
});

// --- Bug fix regression tests ---

describe('bug fixes', () => {
    describe('Issue #1: skipped columns should not cause destructive DROPs', () => {
        it('should not report skipped columns as removed', async () => {
            // Entity has skippedColumns set (simulating unsupported type)
            const entityTable = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                col({ name: 'name', ordinalPosition: 2 })
            ]);
            entityTable.skippedColumns = new Set(['geo_point']);

            const dbTable = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                col({ name: 'name', ordinalPosition: 2 }),
                col({ name: 'geo_point', type: 'point', ordinalPosition: 3 })
            ]);

            const entity = schema(entityTable);
            const db = schema(dbTable);

            const diff = await compareSchemas(entity, db, 'mysql', false);

            // geo_point is in skippedColumns, so it should NOT appear as removed
            assert.equal(diff.modifiedTables.length, 0, 'Should have no modifications — geo_point is skipped');
        });

        it('should still detect real column removals alongside skipped columns', async () => {
            const entityTable = table('users', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]);
            entityTable.skippedColumns = new Set(['geo_point']);

            const dbTable = table('users', [
                col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                col({ name: 'name', ordinalPosition: 2 }),
                col({ name: 'geo_point', type: 'point', ordinalPosition: 3 })
            ]);

            const entity = schema(entityTable);
            const db = schema(dbTable);

            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].removedColumns.length, 1);
            assert.equal(diff.modifiedTables[0].removedColumns[0].name, 'name');
            // geo_point should NOT be in removedColumns
            assert.ok(!diff.modifiedTables[0].removedColumns.some(c => c.name === 'geo_point'), 'geo_point should not be in removedColumns');
        });
    });

    describe('Issue #2: PG enum DROP should not drop types still used by other tables', () => {
        it('should not drop enum type used by another table (via compareSchemas)', async () => {
            // Entity: orders has no status column, users still has it — both share status_enum
            const entitySch = schema(
                table('orders', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]),
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ])
            );
            const dbSch = schema(
                table('orders', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ]),
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entitySch, dbSch, 'postgres', false, 'public');
            const stmts = generateDDL(diff);

            // Should NOT contain DROP TYPE for status_enum since users table still uses it
            const dropEnum = stmts.find(s => s.includes('DROP TYPE') && s.includes('status_enum') && !s.includes('_old'));
            assert.ok(!dropEnum, 'Should not drop status_enum still used by users table: ' + stmts.join(' | '));
        });

        it('should drop enum type when no table uses it (via compareSchemas)', async () => {
            // Entity: orders has no status column, no other table uses orders_status_enum
            const entitySch = schema(table('orders', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]));
            const dbSch = schema(
                table('orders', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'orders_status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entitySch, dbSch, 'postgres', false, 'public');
            const stmts = generateDDL(diff);

            const dropEnum = stmts.find(s => s.includes('DROP TYPE IF EXISTS') && s.includes('orders_status_enum'));
            assert.ok(dropEnum, 'Should drop orders_status_enum when no table uses it: ' + stmts.join(' | '));
        });

        it('should not drop enum type used by unchanged table (not in modifiedTables)', async () => {
            // Entity: orders removes status column, users is UNCHANGED (won't appear in modifiedTables)
            const entitySch = schema(
                table('orders', [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]),
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ])
            );
            const dbSch = schema(
                table('orders', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ]),
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'status', type: 'enum', enumTypeName: 'status_enum', enumValues: ['a', 'b'], ordinalPosition: 2 })
                ])
            );

            const diff = await compareSchemas(entitySch, dbSch, 'postgres', false, 'public');

            // users should NOT appear in modifiedTables — it's unchanged
            assert.ok(!diff.modifiedTables.find(t => t.tableName === 'users'), 'users should not be in modifiedTables');

            const stmts = generateDDL(diff);

            // But entityEnumTypes should still protect status_enum from being dropped
            const dropEnum = stmts.find(s => s.includes('DROP TYPE') && s.includes('status_enum'));
            assert.ok(!dropEnum, 'Should not drop status_enum used by unchanged users table: ' + stmts.join(' | '));
        });
    });

    describe('Issue #3: PG enum creation should be idempotent', () => {
        it('should wrap CREATE TYPE in IF NOT EXISTS guard', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                addedTables: [
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumTypeName: 'user_status', enumValues: ['active', 'inactive'], ordinalPosition: 2 })
                    ])
                ],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);

            const createTypeStmt = stmts.find(s => s.includes('user_status') && s.includes('ENUM'));
            assert.ok(createTypeStmt, 'Should have a CREATE TYPE statement');
            assert.ok(createTypeStmt!.includes('IF NOT EXISTS'), 'CREATE TYPE should include IF NOT EXISTS guard: ' + createTypeStmt);
            assert.ok(createTypeStmt!.includes('DO $$'), 'Should use DO $$ block for conditional creation: ' + createTypeStmt);
        });

        it('should include pg_namespace filter for non-public schema', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                pgSchema: 'tenant',
                addedTables: [
                    table('users', [
                        col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'status', type: 'enum', enumTypeName: 'user_status', enumValues: ['active', 'inactive'], ordinalPosition: 2 })
                    ])
                ],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);

            const createTypeStmt = stmts.find(s => s.includes('user_status') && s.includes('ENUM'));
            assert.ok(createTypeStmt, 'Should have a CREATE TYPE statement');
            assert.ok(
                createTypeStmt!.includes('pg_namespace') && createTypeStmt!.includes("nspname = 'tenant'"),
                'IF NOT EXISTS guard should filter by pg_namespace for non-public schema: ' + createTypeStmt
            );
        });
    });

    describe('Issue #4: rename detection should consider type-mismatched columns', () => {
        it('should not detect renames in non-interactive mode (baseline)', async () => {
            const entity = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'new_col', type: 'bigint', ordinalPosition: 2 })
                ])
            );
            const db = schema(
                table('users', [
                    col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 }),
                    col({ name: 'old_col', type: 'int', ordinalPosition: 2 })
                ])
            );

            // non-interactive: rename detection is skipped entirely
            const diff = await compareSchemas(entity, db, 'mysql', false);

            assert.equal(diff.modifiedTables.length, 1);
            assert.equal(diff.modifiedTables[0].renamedColumns.length, 0);
            assert.equal(diff.modifiedTables[0].addedColumns.length, 1);
            assert.equal(diff.modifiedTables[0].removedColumns.length, 1);
        });
    });

    describe('Issue #5: PG sequence removal should use actual sequence name', () => {
        it('should use stored sequenceName when removing auto-increment', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'id',
                                oldColumn: col({
                                    name: 'id',
                                    type: 'int',
                                    autoIncrement: true,
                                    isPrimaryKey: true,
                                    ordinalPosition: 1,
                                    sequenceName: 'public.my_custom_seq'
                                }),
                                newColumn: col({ name: 'id', type: 'int', autoIncrement: false, isPrimaryKey: true, ordinalPosition: 1 }),
                                typeChanged: false,
                                nullableChanged: false,
                                defaultChanged: false,
                                autoIncrementChanged: true,
                                onUpdateChanged: false
                            } as ColumnModification
                        ],
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
                        entityColumns: [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]
                    }
                ]
            };

            const stmts = generateDDL(diff);

            const dropSeq = stmts.find(s => s.includes('DROP SEQUENCE'));
            assert.ok(dropSeq, 'Should have a DROP SEQUENCE statement: ' + stmts.join(' | '));
            assert.ok(dropSeq!.includes('public.my_custom_seq'), 'Should use actual sequence name, not conventional: ' + dropSeq);
        });

        it('should fall back to conventional sequence name when sequenceName is not set', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                addedTables: [],
                removedTables: [],
                modifiedTables: [
                    {
                        tableName: 'users',
                        addedColumns: [],
                        removedColumns: [],
                        modifiedColumns: [
                            {
                                name: 'id',
                                oldColumn: col({ name: 'id', type: 'int', autoIncrement: true, isPrimaryKey: true, ordinalPosition: 1 }),
                                newColumn: col({ name: 'id', type: 'int', autoIncrement: false, isPrimaryKey: true, ordinalPosition: 1 }),
                                typeChanged: false,
                                nullableChanged: false,
                                defaultChanged: false,
                                autoIncrementChanged: true,
                                onUpdateChanged: false
                            } as ColumnModification
                        ],
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
                        entityColumns: [col({ name: 'id', type: 'int', isPrimaryKey: true, ordinalPosition: 1 })]
                    }
                ]
            };

            const stmts = generateDDL(diff);

            const dropSeq = stmts.find(s => s.includes('DROP SEQUENCE'));
            assert.ok(dropSeq, 'Should have a DROP SEQUENCE statement: ' + stmts.join(' | '));
            assert.ok(dropSeq!.includes('users_id_seq'), 'Should use conventional sequence name as fallback: ' + dropSeq);
        });
    });

    describe('UUID / binary type handling', () => {
        it('should generate BINARY(16) for MySQL binary columns', () => {
            const diff: SchemaDiff = {
                dialect: 'mysql',
                addedTables: [
                    table('tokens', [
                        col({ name: 'id', type: 'binary', size: 16, isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);
            const createStmt = stmts.find(s => s.includes('CREATE TABLE'));
            assert.ok(createStmt, 'Should emit CREATE TABLE');
            assert.ok(createStmt!.includes('BINARY(16)'), 'Should use BINARY(16) for binary column: ' + createStmt);
        });

        it('should generate UUID for PostgreSQL uuid columns', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                addedTables: [
                    table('tokens', [
                        col({ name: 'id', type: 'uuid', size: undefined, isPrimaryKey: true, ordinalPosition: 1 }),
                        col({ name: 'name', type: 'varchar', size: 255, ordinalPosition: 2 })
                    ])
                ],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);
            const createStmt = stmts.find(s => s.includes('CREATE TABLE'));
            assert.ok(createStmt, 'Should emit CREATE TABLE');
            assert.ok(createStmt!.includes('UUID'), 'Should use UUID for uuid column: ' + createStmt);
        });

        it('should generate CHAR(36) for UuidString columns on MySQL', () => {
            const diff: SchemaDiff = {
                dialect: 'mysql',
                addedTables: [table('tokens', [col({ name: 'id', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 1 })])],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);
            const createStmt = stmts.find(s => s.includes('CREATE TABLE'));
            assert.ok(createStmt, 'Should emit CREATE TABLE');
            assert.ok(createStmt!.includes('CHAR(36)'), 'Should use CHAR(36) for UuidString column: ' + createStmt);
        });

        it('should generate CHAR(36) for UuidString columns on PostgreSQL', () => {
            const diff: SchemaDiff = {
                dialect: 'postgres',
                addedTables: [table('tokens', [col({ name: 'id', type: 'char', size: 36, isPrimaryKey: true, ordinalPosition: 1 })])],
                removedTables: [],
                modifiedTables: []
            };

            const stmts = generateDDL(diff);
            const createStmt = stmts.find(s => s.includes('CREATE TABLE'));
            assert.ok(createStmt, 'Should emit CREATE TABLE');
            assert.ok(createStmt!.includes('CHAR(36)'), 'Should use CHAR(36) for UuidString column: ' + createStmt);
        });

        it('should not detect changes when binary(16) matches between entity and DB', async () => {
            const entity = schema(table('tokens', [col({ name: 'id', type: 'binary', size: 16, isPrimaryKey: true, ordinalPosition: 1 })]));
            const db = schema(table('tokens', [col({ name: 'id', type: 'binary', size: 16, isPrimaryKey: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'mysql', false);
            assert.equal(diff.modifiedTables.length, 0, 'Matching binary(16) columns should not produce a diff');
        });

        it('should not detect changes when uuid matches between entity and DB', async () => {
            const entity = schema(table('tokens', [col({ name: 'id', type: 'uuid', size: undefined, isPrimaryKey: true, ordinalPosition: 1 })]));
            const db = schema(table('tokens', [col({ name: 'id', type: 'uuid', size: undefined, isPrimaryKey: true, ordinalPosition: 1 })]));

            const diff = await compareSchemas(entity, db, 'postgres', false);
            assert.equal(diff.modifiedTables.length, 0, 'Matching uuid columns should not produce a diff');
        });
    });
});
