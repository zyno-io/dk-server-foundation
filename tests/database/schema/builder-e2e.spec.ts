import { SQLDatabaseAdapter } from '@deepkit/sql';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { forEachAdapter } from '../../shared/db';

interface ColumnInfo {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
}

interface IndexInfo {
    index_name: string;
    column_name: string;
    is_unique: number | boolean;
}

describe('schema builder e2e', () => {
    forEachAdapter(({ createFacade, type }) => {
        const tf = createFacade({ entities: [] });
        const tableSuffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        const usersTable = `sb_users_${tableSuffix}`;
        const postsTable = `sb_posts_${tableSuffix}`;

        before(
            async () => {
                await tf.start();
            },
            { timeout: 10_000 }
        );

        after(
            async () => {
                const db = tf.getDb();
                // Best-effort cleanup so the same DB can be reused
                for (const t of [postsTable, usersTable]) {
                    try {
                        await db.schema.dropIfExists(t);
                    } catch {
                        /* ignore */
                    }
                }
                await tf.stop();
            },
            { timeout: 10_000 }
        );

        it('creates a table with mixed types and applies deferred FK', { timeout: 20_000 }, async () => {
            const db = tf.getDb();

            await db.schema.create(usersTable, t => {
                t.id();
                t.string('email', 255).notNull().unique();
                t.string('name', 255).nullable();
                t.boolean('active').notNull().default(false);
                t.dateTime('createdAt').notNull().defaultRaw('CURRENT_TIMESTAMP');
                if (type === 'mysql') {
                    t.json('metadata').nullable();
                } else {
                    t.jsonb('metadata').nullable();
                }
            });

            await db.schema.create(postsTable, t => {
                t.id();
                t.bigInteger('userId').unsigned().notNull();
                t.string('title', 200).notNull();
                t.text('body').nullable();
                t.foreign('userId').references('id').on(usersTable).onDelete('cascade');
                t.index('userId');
            });

            await db.schema.flush();

            // --- Introspect users table ---
            const userCols = await readColumns(db, usersTable, type);
            const colNames = userCols.map(c => c.column_name).sort();
            assert.deepEqual(colNames, ['active', 'createdAt', 'email', 'id', 'metadata', 'name']);

            const idCol = userCols.find(c => c.column_name === 'id')!;
            assert.equal(idCol.is_nullable.toUpperCase(), 'NO');

            const nameCol = userCols.find(c => c.column_name === 'name')!;
            assert.equal(nameCol.is_nullable.toUpperCase(), 'YES');

            // --- Introspect posts table FK ---
            const fks = await readForeignKeys(db, postsTable, type);
            assert.equal(fks.length, 1, 'expected one FK on posts table');
            assert.equal(fks[0].referenced_table, usersTable);
            assert.equal(fks[0].referenced_column, 'id');

            // --- Insert and round-trip ---
            await db.rawExecute(
                `INSERT INTO ${quote(type, usersTable)} (${quote(type, 'email')}, ${quote(type, 'active')}) VALUES ('a@b.c', ${type === 'postgres' ? 'true' : '1'})`
            );

            const rows = await db.rawQuery(`SELECT ${quote(type, 'email')} FROM ${quote(type, usersTable)}`);
            assert.equal(rows.length, 1);
        });

        it('emits PG enum CREATE TYPE + CAST exactly once across multiple tables', { timeout: 15_000 }, async () => {
            if (type !== 'postgres') return; // mysql enums are inline, no dedup test

            const db = tf.getDb();
            const t1 = `sb_enum_a_${tableSuffix}`;
            const t2 = `sb_enum_b_${tableSuffix}`;

            try {
                await db.schema.create(t1, t => {
                    t.id();
                    t.enum('status', ['active', 'pending'], 'shared_status');
                });

                // Same shared enum type — should NOT re-create (would fail with "cast already exists")
                await db.schema.create(t2, t => {
                    t.id();
                    t.enum('status', ['active', 'pending'], 'shared_status');
                });

                await db.schema.flush();
            } finally {
                await db.schema.dropIfExists(t2).catch(() => {});
                await db.schema.dropIfExists(t1).catch(() => {});
                // Drop the cast and type so re-running the test is clean
                await db.rawExecute(`DROP CAST IF EXISTS (text AS shared_status)`).catch(() => {});
                await db.rawExecute(`DROP TYPE IF EXISTS shared_status`).catch(() => {});
            }
        });
    });
});

function quote(dialect: 'mysql' | 'postgres', name: string): string {
    return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

async function readColumns(
    db: { adapter: unknown; rawQuery: (sql: string) => Promise<unknown[]> },
    table: string,
    dialect: 'mysql' | 'postgres'
): Promise<ColumnInfo[]> {
    if (dialect === 'mysql') {
        
        // information_schema.COLUMNS works on MySQL — table_schema = current DB
        const rows = (await db.rawQuery(
            `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
        )) as ColumnInfo[];
        return rows;
    }
    const rows = (await db.rawQuery(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${table}' AND table_schema = current_schema()`
    )) as ColumnInfo[];
    return rows;
}

async function readForeignKeys(
    db: { rawQuery: (sql: string) => Promise<unknown[]> },
    table: string,
    dialect: 'mysql' | 'postgres'
): Promise<{ referenced_table: string; referenced_column: string }[]> {
    if (dialect === 'mysql') {
        const rows = (await db.rawQuery(
            `SELECT REFERENCED_TABLE_NAME AS referenced_table, REFERENCED_COLUMN_NAME AS referenced_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND REFERENCED_TABLE_NAME IS NOT NULL`
        )) as { referenced_table: string; referenced_column: string }[];
        return rows;
    }
    const rows = (await db.rawQuery(
        `SELECT ccu.table_name AS referenced_table, ccu.column_name AS referenced_column FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '${table}'`
    )) as { referenced_table: string; referenced_column: string }[];
    return rows;
}
