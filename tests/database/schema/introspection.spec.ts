import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { forEachAdapter } from '../../shared/db';

describe('schema introspection (hasTable / hasColumn / hasIndex)', () => {
    forEachAdapter(({ createFacade }) => {
        const tf = createFacade({ entities: [] });
        const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        const tbl = `sb_intro_${suffix}`;

        before(
            async () => {
                await tf.start();
                const db = tf.getDb();
                await db.schema.create(tbl, t => {
                    t.id();
                    t.string('email', 255).notNull().unique();
                    t.string('name', 100).nullable();
                    t.index('name');
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

        it('hasTable returns true for an existing table, false otherwise', { timeout: 10_000 }, async () => {
            const db = tf.getDb();
            assert.equal(await db.schema.hasTable(tbl), true);
            assert.equal(await db.schema.hasTable('sb_does_not_exist_xyz'), false);
        });

        it('hasColumn returns true / false', { timeout: 10_000 }, async () => {
            const db = tf.getDb();
            assert.equal(await db.schema.hasColumn(tbl, 'email'), true);
            assert.equal(await db.schema.hasColumn(tbl, 'not_a_column'), false);
            // Non-existent table → false
            assert.equal(await db.schema.hasColumn('sb_no_table_xyz', 'email'), false);
        });

        it('hasIndex returns true / false', { timeout: 10_000 }, async () => {
            const db = tf.getDb();
            assert.equal(await db.schema.hasIndex(tbl, `${tbl}_email_unique`), true);
            assert.equal(await db.schema.hasIndex(tbl, `${tbl}_name_index`), true);
            assert.equal(await db.schema.hasIndex(tbl, 'no_such_index'), false);
        });
    });
});
