import { ActiveRecord } from '@deepkit/orm';
import { AutoIncrement, entity, Index, PrimaryKey, Reference, Unique } from '@deepkit/type';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { BaseDatabase } from '../../../src';
import { generateBuilderMigrationFile } from '../../../src/database/migration/create/builder-regenerator';
import { compareSchemas } from '../../../src/database/migration/create/comparator';
import { readDatabaseSchema } from '../../../src/database/migration/create/db-reader';
import { readEntitiesSchema } from '../../../src/database/migration/create/entity-reader';
import { forEachAdapter } from '../../shared/db';

@entity.name('smoke_orgs')
class SmokeOrg extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
    active: boolean = true;
    createdAt: Date = new Date();
}

@entity.name('smoke_users')
class SmokeUser extends ActiveRecord {
    id!: number & AutoIncrement & PrimaryKey;
    email!: string & Unique;
    displayName?: string;
    orgId!: SmokeOrg & Reference;
    role!: 'admin' | 'member' | 'viewer';
    loginCount!: number & Index;
    createdAt: Date = new Date();
}

// Compile a builder-based migration source into an executable function (no filesystem)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (db: BaseDatabase) => Promise<void>;

function compileMigration(source: string): (db: BaseDatabase) => Promise<void> {
    const start = source.indexOf('async db => {');
    const end = source.lastIndexOf('});');
    if (start < 0 || end < 0) throw new Error('Could not locate migration body in:\n' + source);
    const body = source.slice(start + 'async db => {'.length, end);
    return new AsyncFunction('db', body);
}

describe('smoke: builder round-trip via migration:reset → run → no diff', () => {
    forEachAdapter(({ createFacade, type }) => {
        const tf = createFacade({ entities: [SmokeOrg, SmokeUser] });

        before(
            async () => {
                await tf.start();
            },
            { timeout: 15_000 }
        );

        after(
            async () => {
                const db = tf.getDb();
                // Drop in dependency order
                for (const t of ['smoke_users', 'smoke_orgs']) {
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

        it('produces a migration that reproduces the entity schema exactly', { timeout: 30_000 }, async () => {
            const db = tf.getDb();
            const dialect = type;

            // 1. Read entity schema
            const entitySchema = readEntitiesSchema(db, dialect);
            const tables = Array.from(entitySchema.values());
            assert.ok(tables.length >= 2, `expected at least 2 entity tables, got ${tables.length}`);

            // 2. Generate builder migration source
            const source = generateBuilderMigrationFile(tables);

            // Sanity: the source contains both expected create() calls
            assert.match(source, /db\.schema\.create\('smoke_orgs'/);
            assert.match(source, /db\.schema\.create\('smoke_users'/);

            // 3. Compile + execute (mimics migration runner)
            const migration = compileMigration(source);
            await migration(db);
            await db.schema.flush();

            // 4. Round-trip: re-introspect DB, compare against entities — expect no diff
            const tableNames = tables.map(t => t.name);
            const pgSchema = dialect === 'postgres' ? 'public' : 'public';
            const dbSchema = await readDatabaseSchema(db, dialect, tableNames, pgSchema);
            const diff = await compareSchemas(entitySchema, dbSchema, dialect, false, pgSchema);

            assert.equal(diff.addedTables.length, 0, `unexpected addedTables: ${diff.addedTables.map(t => t.name).join(', ')}`);
            assert.equal(diff.removedTables.length, 0, `unexpected removedTables: ${diff.removedTables.map(t => t.name).join(', ')}`);

            for (const td of diff.modifiedTables) {
                const anyChange =
                    td.addedColumns.length +
                    td.removedColumns.length +
                    td.modifiedColumns.length +
                    td.renamedColumns.length +
                    td.addedIndexes.length +
                    td.removedIndexes.length +
                    td.addedForeignKeys.length +
                    td.removedForeignKeys.length;
                if (anyChange > 0) {
                    const summary = {
                        added: td.addedColumns.map(c => c.name),
                        removed: td.removedColumns.map(c => c.name),
                        modified: td.modifiedColumns.map(m => `${m.name}(type=${m.typeChanged}, null=${m.nullableChanged}, def=${m.defaultChanged})`),
                        renamed: td.renamedColumns.map(r => `${r.from}→${r.to}`),
                        addIdx: td.addedIndexes.map(i => i.name),
                        rmIdx: td.removedIndexes.map(i => i.name),
                        addFk: td.addedForeignKeys.map(f => f.name),
                        rmFk: td.removedForeignKeys.map(f => f.name),
                        pkChanged: td.primaryKeyChanged
                    };
                    assert.fail(`Round-trip drift on ${td.tableName}: ${JSON.stringify(summary)}`);
                }
            }
        });
    });
});
