import { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../migration/create/schema-model';
import { BlueprintBase } from './BlueprintBase';
import { ColumnDefinition } from './ColumnDefinition';

/** Create-table blueprint. Records columns + indexes + FKs and renders a TableSchema. */
export class Blueprint extends BlueprintBase {
    public readonly columns: ColumnSchema[] = [];
    public readonly indexes: IndexSchema[] = [];
    public readonly foreignKeys: ForeignKeySchema[] = [];

    protected addColumnImpl(col: ColumnSchema): ColumnDefinition {
        this.columns.push(col);
        return new ColumnDefinition(this, col);
    }

    protected addIndexImpl(idx: IndexSchema): void {
        this.indexes.push(idx);
    }

    protected addForeignKeyImpl(fk: ForeignKeySchema): void {
        this.foreignKeys.push(fk);
    }

    /** Composite primary key — replaces single-column .primary() flag with a multi-column PK. */
    primary(columns: string[]): this {
        for (const col of this.columns) {
            col.isPrimaryKey = columns.includes(col.name);
        }
        return this;
    }

    build(): TableSchema {
        this.columns.forEach((col, i) => {
            col.ordinalPosition = i + 1;
        });
        return {
            name: this.tableName,
            columns: this.columns,
            indexes: this.indexes,
            foreignKeys: this.foreignKeys
        };
    }
}
