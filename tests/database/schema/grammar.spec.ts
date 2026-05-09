import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MySQLGrammar, PostgresGrammar } from '../../../src';
import { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../../src/database/migration/create/schema-model';

const baseCol = (overrides: Partial<ColumnSchema>): ColumnSchema => ({
    name: 'col',
    type: 'varchar',
    unsigned: false,
    nullable: false,
    autoIncrement: false,
    isPrimaryKey: false,
    ordinalPosition: 1,
    ...overrides
});

const baseTable = (name: string, columns: ColumnSchema[]): TableSchema => ({
    name,
    columns,
    indexes: [],
    foreignKeys: []
});

describe('MySQLGrammar', () => {
    const g = new MySQLGrammar();

    describe('createTable', () => {
        it('emits VARCHAR with size', () => {
            const sql = g.createTable(baseTable('users', [baseCol({ name: 'email', type: 'varchar', size: 255 })]));
            assert.match(sql, /CREATE TABLE `users`/);
            assert.match(sql, /`email` VARCHAR\(255\) NOT NULL/);
        });

        it('marks PK and AUTO_INCREMENT for id', () => {
            const sql = g.createTable(
                baseTable('users', [baseCol({ name: 'id', type: 'bigint', unsigned: true, autoIncrement: true, isPrimaryKey: true })])
            );
            assert.match(sql, /`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT/);
            assert.match(sql, /PRIMARY KEY \(`id`\)/);
        });

        it('renders TINYINT(1) for boolean', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'active', type: 'boolean' })]));
            assert.match(sql, /`active` TINYINT\(1\) NOT NULL/);
        });

        it('renders DEFAULT literal and DEFAULT expression', () => {
            const sql = g.createTable(
                baseTable('t', [
                    baseCol({ name: 'a', defaultValue: 'hi' }),
                    baseCol({ name: 'b', type: 'datetime', defaultExpression: 'CURRENT_TIMESTAMP' })
                ])
            );
            assert.match(sql, /`a` VARCHAR\(255\) NOT NULL DEFAULT 'hi'/);
            assert.match(sql, /`b` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP/);
        });

        it('renders ON UPDATE expression', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'updatedAt', type: 'datetime', onUpdateExpression: 'CURRENT_TIMESTAMP' })]));
            assert.match(sql, /`updatedAt` DATETIME NOT NULL ON UPDATE CURRENT_TIMESTAMP/);
        });

        it('renders inline ENUM', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'status', type: 'enum', enumValues: ['a', 'b', 'c'] })]));
            assert.match(sql, /`status` ENUM\('a','b','c'\) NOT NULL/);
        });

        it('renders POINT', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'loc', type: 'point' })]));
            assert.match(sql, /`loc` POINT NOT NULL/);
        });

        it('emits composite PK', () => {
            const sql = g.createTable(
                baseTable('pivot', [baseCol({ name: 'a', type: 'int', isPrimaryKey: true }), baseCol({ name: 'b', type: 'int', isPrimaryKey: true })])
            );
            assert.match(sql, /PRIMARY KEY \(`a`, `b`\)/);
        });

        it('escapes single quotes in defaults', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'x', defaultValue: "it's" })]));
            assert.match(sql, /DEFAULT 'it''s'/);
        });

        it('escapes backslashes in defaults (mysql-only)', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'x', defaultValue: 'a\\b' })]));
            assert.match(sql, /DEFAULT 'a\\\\b'/);
        });
    });

    describe('createIndex', () => {
        it('emits regular index', () => {
            const idx: IndexSchema = { name: 'users_email_index', columns: ['email'], unique: false, spatial: false };
            assert.equal(g.createIndex('users', idx), 'CREATE INDEX `users_email_index` ON `users` (`email`)');
        });

        it('emits UNIQUE index', () => {
            const idx: IndexSchema = { name: 'users_email_unique', columns: ['email'], unique: true, spatial: false };
            assert.match(g.createIndex('users', idx), /CREATE UNIQUE INDEX/);
        });

        it('emits SPATIAL index', () => {
            const idx: IndexSchema = { name: 'p_loc_spatial', columns: ['loc'], unique: false, spatial: true };
            assert.match(g.createIndex('p', idx), /CREATE SPATIAL INDEX/);
        });

        it('emits multi-column index', () => {
            const idx: IndexSchema = { name: 'i', columns: ['a', 'b'], unique: false, spatial: false };
            assert.match(g.createIndex('t', idx), /\(`a`, `b`\)/);
        });
    });

    describe('addForeignKey', () => {
        it('emits ALTER TABLE ADD CONSTRAINT', () => {
            const fk: ForeignKeySchema = {
                name: 'posts_userId_foreign',
                columns: ['userId'],
                referencedTable: 'users',
                referencedColumns: ['id'],
                onDelete: 'CASCADE',
                onUpdate: 'RESTRICT'
            };
            const sql = g.addForeignKey('posts', fk);
            assert.match(sql, /ALTER TABLE `posts` ADD CONSTRAINT `posts_userId_foreign`/);
            assert.match(sql, /FOREIGN KEY \(`userId`\) REFERENCES `users` \(`id`\)/);
            assert.match(sql, /ON DELETE CASCADE ON UPDATE RESTRICT/);
        });

        it('rejects SET DEFAULT', () => {
            const fk: ForeignKeySchema = {
                name: 'x',
                columns: ['a'],
                referencedTable: 'b',
                referencedColumns: ['id'],
                onDelete: 'SET DEFAULT',
                onUpdate: 'RESTRICT'
            };
            assert.throws(() => g.addForeignKey('t', fk), /SET DEFAULT.*not supported by MySQL/);
        });

        it('rejects unknown actions', () => {
            const fk: ForeignKeySchema = {
                name: 'x',
                columns: ['a'],
                referencedTable: 'b',
                referencedColumns: ['id'],
                onDelete: 'BOGUS',
                onUpdate: 'RESTRICT'
            };
            assert.throws(() => g.addForeignKey('t', fk), /Invalid foreign key action/);
        });
    });

    describe('createEnumType', () => {
        it('returns empty array (no PG type machinery on mysql)', () => {
            assert.deepEqual(g.createEnumType('status', ['a', 'b']), []);
        });
    });
});

describe('PostgresGrammar', () => {
    const g = new PostgresGrammar('public');
    const gNS = new PostgresGrammar('myschema');

    describe('createTable', () => {
        it('emits VARCHAR with size and double-quoted identifiers', () => {
            const sql = g.createTable(baseTable('users', [baseCol({ name: 'email', type: 'varchar', size: 255 })]));
            assert.match(sql, /CREATE TABLE "users"/);
            assert.match(sql, /"email" VARCHAR\(255\) NOT NULL/);
        });

        it('renders BIGSERIAL for autoincrement bigint', () => {
            const sql = g.createTable(baseTable('users', [baseCol({ name: 'id', type: 'bigint', autoIncrement: true, isPrimaryKey: true })]));
            assert.match(sql, /"id" BIGSERIAL/);
            assert.doesNotMatch(sql, /NOT NULL/); // SERIAL implies NOT NULL
            assert.match(sql, /PRIMARY KEY \("id"\)/);
        });

        it('renders SERIAL for autoincrement int', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'id', type: 'int', autoIncrement: true })]));
            assert.match(sql, /"id" SERIAL/);
        });

        it('renders BOOLEAN', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'active', type: 'boolean' })]));
            assert.match(sql, /"active" BOOLEAN NOT NULL/);
        });

        it('renders qualified type for enum', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'status', type: 'enum', enumTypeName: 'status_t' })]));
            assert.match(sql, /"status" "status_t" NOT NULL/);
        });

        it('uses pg_schema for qualified enum names', () => {
            const sql = gNS.createTable(baseTable('t', [baseCol({ name: 'status', type: 'enum', enumTypeName: 'status_t' })]));
            assert.match(sql, /"status" "myschema"\."status_t" NOT NULL/);
        });

        it('renders TIMESTAMPTZ', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'at', type: 'timestamptz' })]));
            assert.match(sql, /"at" TIMESTAMPTZ NOT NULL/);
        });

        it('renders JSONB', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'meta', type: 'jsonb' })]));
            assert.match(sql, /"meta" JSONB NOT NULL/);
        });

        it('renders UUID natively', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'id', type: 'uuid' })]));
            assert.match(sql, /"id" UUID NOT NULL/);
        });

        it('renders BYTEA', () => {
            const sql = g.createTable(baseTable('t', [baseCol({ name: 'b', type: 'bytea' })]));
            assert.match(sql, /"b" BYTEA NOT NULL/);
        });

        it('qualifies tables with non-public pg_schema', () => {
            const sql = gNS.createTable(baseTable('t', [baseCol({ name: 'x', type: 'int' })]));
            assert.match(sql, /CREATE TABLE "myschema"\."t"/);
        });
    });

    describe('createIndex', () => {
        it('omits SPATIAL prefix even when flag set', () => {
            const idx: IndexSchema = { name: 'p_loc_spatial', columns: ['loc'], unique: false, spatial: true };
            const sql = g.createIndex('p', idx);
            assert.match(sql, /^CREATE INDEX/);
            assert.doesNotMatch(sql, /SPATIAL/);
        });
    });

    describe('createEnumType', () => {
        it('emits idempotent DO $$ block + CREATE CAST', () => {
            const stmts = g.createEnumType('status', ['a', 'b']);
            assert.equal(stmts.length, 2);
            assert.match(stmts[0], /DO \$\$ BEGIN/);
            assert.match(stmts[0], /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'status'\)/);
            assert.match(stmts[0], /CREATE TYPE "status" AS ENUM \('a', 'b'\)/);
            assert.match(stmts[0], /END IF;/);
            assert.match(stmts[0], /END \$\$/);
            assert.match(stmts[1], /CREATE CAST \(text AS "status"\) WITH INOUT AS IMPLICIT/);
        });

        it('qualifies type name with non-public pg_schema and adds typnamespace filter', () => {
            const stmts = gNS.createEnumType('status', ['a']);
            assert.match(stmts[0], /CREATE TYPE "myschema"\."status"/);
            assert.match(stmts[0], /typnamespace = \(SELECT oid FROM pg_namespace WHERE nspname = 'myschema'\)/);
        });
    });

    describe('addForeignKey', () => {
        it('allows SET DEFAULT on PG', () => {
            const fk: ForeignKeySchema = {
                name: 'x',
                columns: ['a'],
                referencedTable: 'b',
                referencedColumns: ['id'],
                onDelete: 'SET DEFAULT',
                onUpdate: 'RESTRICT'
            };
            const sql = g.addForeignKey('t', fk);
            assert.match(sql, /ON DELETE SET DEFAULT/);
        });
    });

    describe('renameTable', () => {
        it('uses ALTER TABLE ... RENAME TO syntax', () => {
            assert.equal(g.renameTable('a', 'b'), 'ALTER TABLE "a" RENAME TO "b"');
        });
    });
});
