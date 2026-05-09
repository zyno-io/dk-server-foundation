import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { forEachAdapter } from '../../shared/db';

describe('schema.alter() e2e', () => {
    forEachAdapter(({ createFacade, type }) => {
        const tf = createFacade({ entities: [] });
        const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        const tbl = `sb_alter_${suffix}`;
        const refTbl = `sb_alter_ref_${suffix}`;

        before(
            async () => {
                await tf.start();
                const db = tf.getDb();

                await db.schema.create(refTbl, t => {
                    t.id();
                    t.string('label', 64).notNull();
                });

                await db.schema.create(tbl, t => {
                    t.id();
                    t.string('email', 255).notNull().unique();
                    t.string('legacy_field', 100).nullable();
                    t.bigInteger('refId').unsigned().nullable();
                    t.dateTime('createdAt').notNull().defaultRaw('CURRENT_TIMESTAMP');
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
                try {
                    await db.schema.dropIfExists(refTbl);
                } catch {
                    /* ignore */
                }
                await tf.stop();
            },
            { timeout: 10_000 }
        );

        it('add/drop/rename columns and add an FK', { timeout: 20_000 }, async () => {
            const db = tf.getDb();

            await db.schema.alter(tbl, t => {
                t.string('phone', 20).nullable();
                t.boolean('active').notNull().default(false);
                t.dropColumn('legacy_field');
                t.renameColumn('email', 'email_address');
                t.foreign('refId').references('id').on(refTbl).onDelete('set null');
            });
            await db.schema.flush();

            const cols = await readColumnNames(db, tbl, type);
            const sorted = cols.sort();
            assert.deepEqual(sorted, ['active', 'createdAt', 'email_address', 'id', 'phone', 'refId']);

            const fks = await readFkRefs(db, tbl, type);
            assert.equal(fks.length, 1);
            assert.equal(fks[0].referenced_table, refTbl);
        });

        it('drop an index by name', { timeout: 15_000 }, async () => {
            const db = tf.getDb();
            // The unique index from create() — name follows default convention
            await db.schema.alter(tbl, t => {
                t.dropUnique(`${tbl}_email_unique`);
            });

            const indexes = await readIndexNames(db, tbl, type);
            assert.ok(!indexes.includes(`${tbl}_email_unique`), `expected unique index to be dropped, got: ${indexes.join(', ')}`);
        });

        it('drop the FK we added', { timeout: 15_000 }, async () => {
            const db = tf.getDb();
            await db.schema.alter(tbl, t => {
                t.dropForeign(`${tbl}_refId_foreign`);
            });
            const fks = await readFkRefs(db, tbl, type);
            assert.equal(fks.length, 0);
        });
    });
});

async function readColumnNames(
    db: { rawQuery: (sql: string) => Promise<unknown[]> },
    table: string,
    dialect: 'mysql' | 'postgres'
): Promise<string[]> {
    if (dialect === 'mysql') {
        const rows = (await db.rawQuery(
            `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
        )) as { column_name: string }[];
        return rows.map(r => r.column_name);
    }
    const rows = (await db.rawQuery(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' AND table_schema = current_schema()`
    )) as { column_name: string }[];
    return rows.map(r => r.column_name);
}

async function readIndexNames(
    db: { rawQuery: (sql: string) => Promise<unknown[]> },
    table: string,
    dialect: 'mysql' | 'postgres'
): Promise<string[]> {
    if (dialect === 'mysql') {
        const rows = (await db.rawQuery(
            `SELECT DISTINCT INDEX_NAME AS index_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
        )) as { index_name: string }[];
        return rows.map(r => r.index_name);
    }
    const rows = (await db.rawQuery(`SELECT indexname AS index_name FROM pg_indexes WHERE tablename = '${table}'`)) as { index_name: string }[];
    return rows.map(r => r.index_name);
}

async function readFkRefs(
    db: { rawQuery: (sql: string) => Promise<unknown[]> },
    table: string,
    dialect: 'mysql' | 'postgres'
): Promise<{ referenced_table: string }[]> {
    if (dialect === 'mysql') {
        const rows = (await db.rawQuery(
            `SELECT REFERENCED_TABLE_NAME AS referenced_table FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND REFERENCED_TABLE_NAME IS NOT NULL`
        )) as { referenced_table: string }[];
        return rows;
    }
    const rows = (await db.rawQuery(
        `SELECT ccu.table_name AS referenced_table FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '${table}'`
    )) as { referenced_table: string }[];
    return rows;
}
