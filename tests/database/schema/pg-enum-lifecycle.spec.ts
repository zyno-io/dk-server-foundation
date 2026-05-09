import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestingFacadeWithDatabase } from '../../shared/db';

/** Postgres-specific enum lifecycle: ADD VALUE, value list introspection. */
describe('PG enum lifecycle e2e', () => {
    if (!process.env.PG_HOST) return;

    const tf = createTestingFacadeWithDatabase({ entities: [], dbType: 'postgres' });
    const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const tbl = `sb_pg_enum_${suffix}`;
    const enumName = `sb_pg_status_${suffix}`;

    before(
        async () => {
            await tf.start();
            const db = tf.getDb();
            await db.schema.create(tbl, t => {
                t.id();
                t.enum('status', ['active', 'pending'], enumName).notNull().default('pending');
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
                await db.rawExecute(`DROP CAST IF EXISTS (text AS "${enumName}")`);
            } catch {
                /* ignore */
            }
            try {
                await db.rawExecute(`DROP TYPE IF EXISTS "${enumName}"`);
            } catch {
                /* ignore */
            }
            await tf.stop();
        },
        { timeout: 10_000 }
    );

    it('inserts an existing enum value', { timeout: 10_000 }, async () => {
        const db = tf.getDb();
        await db.rawExecute(`INSERT INTO "${tbl}" ("status") VALUES ('active')`);
        const rows = (await db.rawQuery(`SELECT "status" FROM "${tbl}"`)) as { status: string }[];
        assert.ok(rows.some(r => r.status === 'active'));
    });

    it('rejects an unknown enum value before ADD VALUE', { timeout: 10_000 }, async () => {
        const db = tf.getDb();
        await assert.rejects(db.rawExecute(`INSERT INTO "${tbl}" ("status") VALUES ('archived')`), /invalid input value for enum/);
    });

    it('ADD VALUE makes a new value insertable', { timeout: 10_000 }, async () => {
        const db = tf.getDb();
        await db.schema.raw(`ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'archived'`);
        await db.rawExecute(`INSERT INTO "${tbl}" ("status") VALUES ('archived')`);
        const rows = (await db.rawQuery(`SELECT "status" FROM "${tbl}" WHERE "status" = 'archived'`)) as { status: string }[];
        assert.equal(rows.length, 1);
    });

    it('introspection sees the added value', { timeout: 10_000 }, async () => {
        const db = tf.getDb();
        const rows = (await db.rawQuery(
            `SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = '${enumName}') ORDER BY enumsortorder`
        )) as { enumlabel: string }[];
        const values = rows.map(r => r.enumlabel);
        assert.deepEqual(values, ['active', 'pending', 'archived']);
    });
});
