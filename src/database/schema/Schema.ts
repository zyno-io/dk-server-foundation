import { BaseDatabase } from '../common';
import { Dialect, tableExistsSql } from '../dialect';
import { ForeignKeySchema } from '../migration/create/schema-model';
import { AlterBlueprint } from './AlterBlueprint';
import { Blueprint } from './Blueprint';
import { Grammar } from './grammar/Grammar';

export class Schema {
    private readonly enumTypeRegistry = new Set<string>();
    private readonly pendingForeignKeys: { tableName: string; fk: ForeignKeySchema }[] = [];

    constructor(
        public readonly db: BaseDatabase,
        public readonly grammar: Grammar
    ) {}

    /** Create a new table. Inline FKs are deferred until flush() (auto-called at migration end). */
    async create(name: string, fn: (t: Blueprint) => void): Promise<void> {
        const blueprint = new Blueprint(name, this.grammar);
        fn(blueprint);
        const table = blueprint.build();

        for (const col of table.columns) {
            if (col.type === 'enum' && col.enumTypeName && col.enumValues) {
                await this.ensureEnumType(col.enumTypeName, col.enumValues);
            }
        }

        await this.db.rawExecute(this.grammar.createTable(table));

        for (const idx of table.indexes) {
            await this.db.rawExecute(this.grammar.createIndex(name, idx));
        }

        for (const fk of table.foreignKeys) {
            this.pendingForeignKeys.push({ tableName: name, fk });
        }
    }

    /** Modify an existing table — add/drop/rename/change columns, add/drop indexes & FKs, change PK. */
    async alter(name: string, fn: (t: AlterBlueprint) => void): Promise<void> {
        const blueprint = new AlterBlueprint(name, this.grammar);
        fn(blueprint);

        // Order: drops first (to free up names/refs), then renames, then PG enum prep, then adds/modifies.
        for (const fkName of blueprint.droppedForeignKeys) {
            await this.db.rawExecute(this.grammar.dropForeignKey(name, fkName));
        }
        for (const idxName of blueprint.droppedIndexes) {
            await this.db.rawExecute(this.grammar.dropIndex(name, idxName));
        }
        if (blueprint.dropsPrimaryKey) {
            await this.db.rawExecute(this.grammar.dropPrimaryKey(name));
        }
        for (const colName of blueprint.droppedColumns) {
            await this.db.rawExecute(this.grammar.dropColumn(name, colName));
        }
        for (const { from, to } of blueprint.renamedColumns) {
            await this.db.rawExecute(this.grammar.renameColumn(name, from, to));
        }

        // Pre-create PG enum types for any added/modified columns
        for (const col of [...blueprint.addedColumns, ...blueprint.modifiedColumns]) {
            if (col.type === 'enum' && col.enumTypeName && col.enumValues) {
                await this.ensureEnumType(col.enumTypeName, col.enumValues);
            }
        }

        for (const col of blueprint.addedColumns) {
            await this.db.rawExecute(this.grammar.addColumn(name, col));
        }
        for (const col of blueprint.modifiedColumns) {
            for (const stmt of this.grammar.modifyColumn(name, col)) {
                await this.db.rawExecute(stmt);
            }
        }

        if (blueprint.newPrimaryKey) {
            await this.db.rawExecute(this.grammar.addPrimaryKey(name, blueprint.newPrimaryKey));
        }
        for (const idx of blueprint.addedIndexes) {
            await this.db.rawExecute(this.grammar.createIndex(name, idx));
        }

        // Defer added FKs until flush() so cross-table refs can resolve
        for (const fk of blueprint.addedForeignKeys) {
            this.pendingForeignKeys.push({ tableName: name, fk });
        }
    }

    async drop(name: string): Promise<void> {
        await this.db.rawExecute(this.grammar.dropTable(name));
    }

    async dropIfExists(name: string): Promise<void> {
        await this.db.rawExecute(this.grammar.dropTableIfExists(name));
    }

    async rename(from: string, to: string): Promise<void> {
        await this.db.rawExecute(this.grammar.renameTable(from, to));
    }

    /** Explicitly create a (PG) enum type. Deduped per Schema instance. No-op on MySQL. */
    async enumType(name: string, values: string[]): Promise<void> {
        await this.ensureEnumType(name, values);
    }

    /** Execute raw SQL. Escape hatch for cases the builder does not cover. */
    async raw(sql: string): Promise<void> {
        await this.db.rawExecute(sql);
    }

    /** Run a block only when running against the given dialect. */
    async onlyOn(dialect: Dialect, fn: () => Promise<void>): Promise<void> {
        if (this.grammar.dialect === dialect) await fn();
    }

    // --- Introspection (for conditional/idempotent migrations) ---

    async hasTable(name: string): Promise<boolean> {
        const sql = tableExistsSql(this.grammar.dialect, name, this.grammar.pgSchema);
        const rows = await this.db.rawQuery(sql);
        return rows.length > 0;
    }

    async hasColumn(table: string, column: string): Promise<boolean> {
        const sql =
            this.grammar.dialect === 'mysql'
                ? `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${escapeLiteral(table)}' AND COLUMN_NAME = '${escapeLiteral(column)}'`
                : `SELECT 1 FROM information_schema.columns WHERE table_schema = '${escapeLiteral(this.grammar.pgSchema)}' AND table_name = '${escapeLiteral(table)}' AND column_name = '${escapeLiteral(column)}'`;
        const rows = await this.db.rawQuery(sql);
        return rows.length > 0;
    }

    async hasIndex(table: string, indexName: string): Promise<boolean> {
        const sql =
            this.grammar.dialect === 'mysql'
                ? `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${escapeLiteral(table)}' AND INDEX_NAME = '${escapeLiteral(indexName)}' LIMIT 1`
                : `SELECT 1 FROM pg_indexes WHERE schemaname = '${escapeLiteral(this.grammar.pgSchema)}' AND tablename = '${escapeLiteral(table)}' AND indexname = '${escapeLiteral(indexName)}'`;
        const rows = await this.db.rawQuery(sql);
        return rows.length > 0;
    }

    /** Apply deferred FKs and clear per-cycle state. Called automatically by the migration runner. */
    async flush(): Promise<void> {
        for (const { tableName, fk } of this.pendingForeignKeys) {
            await this.db.rawExecute(this.grammar.addForeignKey(tableName, fk));
        }
        this.pendingForeignKeys.length = 0;
        this.enumTypeRegistry.clear();
    }

    private async ensureEnumType(name: string, values: string[]): Promise<void> {
        if (this.enumTypeRegistry.has(name)) return;
        this.enumTypeRegistry.add(name);
        for (const stmt of this.grammar.createEnumType(name, values)) {
            await this.db.rawExecute(stmt);
        }
    }
}

function escapeLiteral(s: string): string {
    return s.replace(/'/g, "''");
}
