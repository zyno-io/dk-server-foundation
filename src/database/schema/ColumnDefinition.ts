import type { AlterBlueprint } from './AlterBlueprint';
import type { BlueprintBase } from './BlueprintBase';

import { ColumnSchema, ForeignKeySchema } from '../migration/create/schema-model';

export class ColumnDefinition {
    constructor(
        private readonly blueprint: BlueprintBase,
        public readonly column: ColumnSchema
    ) {}

    nullable(value: boolean = true): this {
        this.column.nullable = value;
        return this;
    }

    notNull(): this {
        this.column.nullable = false;
        return this;
    }

    default(value: unknown): this {
        this.column.defaultValue = value;
        this.column.defaultExpression = undefined;
        return this;
    }

    /** Raw SQL expression for the default, e.g. `NOW()`, `CURRENT_TIMESTAMP`. */
    defaultRaw(expression: string): this {
        this.column.defaultExpression = expression;
        this.column.defaultValue = undefined;
        return this;
    }

    /** MySQL only — silently ignored on other dialects. */
    unsigned(value: boolean = true): this {
        this.column.unsigned = value;
        return this;
    }

    /** MySQL only — emits ON UPDATE clause for timestamp columns. */
    onUpdate(expression: string): this {
        this.column.onUpdateExpression = expression;
        return this;
    }

    autoIncrement(value: boolean = true): this {
        this.column.autoIncrement = value;
        return this;
    }

    primary(): this {
        this.column.isPrimaryKey = true;
        return this;
    }

    unique(indexName?: string): this {
        this.blueprint.unique([this.column.name], indexName);
        return this;
    }

    index(indexName?: string): this {
        this.blueprint.index([this.column.name], indexName);
        return this;
    }

    /** Begin a FK declaration: t.bigInteger('userId').references('id').on('users').onDelete('cascade'). */
    references(referencedColumn: string): ForeignKeyBuilder {
        const fk = this.blueprint.foreign(this.column.name);
        return fk.references(referencedColumn);
    }

    /**
     * Mark this column as a modification of an existing column rather than a new add.
     * Only valid inside `db.schema.alter(...)`. No-op (and a wasted call) inside `create(...)`.
     */
    change(): this {
        const host = this.blueprint as unknown as Partial<AlterBlueprint>;
        if (typeof host.markColumnAsModified === 'function') {
            host.markColumnAsModified(this.column);
        }
        return this;
    }

    /** MySQL only — position this column AFTER the given column in ALTER TABLE ADD COLUMN. Silent no-op on PG. */
    after(columnName: string): this {
        this.column.afterColumn = columnName;
        return this;
    }

    /** MySQL only — position this column FIRST in ALTER TABLE ADD COLUMN. Silent no-op on PG. */
    first(): this {
        this.column.afterColumn = null;
        return this;
    }
}

export class ForeignKeyBuilder {
    constructor(public readonly fk: ForeignKeySchema) {}

    references(column: string): this {
        this.fk.referencedColumns = [column];
        return this;
    }

    /** Multi-column variant. */
    referencesAll(columns: string[]): this {
        this.fk.referencedColumns = columns;
        return this;
    }

    on(table: string): this {
        this.fk.referencedTable = table;
        return this;
    }

    onDelete(action: string): this {
        this.fk.onDelete = action;
        return this;
    }

    onUpdate(action: string): this {
        this.fk.onUpdate = action;
        return this;
    }

    name(constraintName: string): this {
        this.fk.name = constraintName;
        return this;
    }
}
