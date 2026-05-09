import { ColumnSchema, ForeignKeySchema, IndexSchema } from '../migration/create/schema-model';
import { BlueprintBase } from './BlueprintBase';
import { ColumnDefinition } from './ColumnDefinition';

/**
 * Alter-table blueprint. Records discrete operations (add/drop/rename/change column,
 * add/drop index/FK, set/drop primary key) for an existing table.
 *
 * Inherits all column-type methods from BlueprintBase — by default a column added via
 * `t.string('email')` becomes an ADD COLUMN. Call `.change()` on the returned ColumnDefinition
 * to mark it as a modification (MODIFY COLUMN / ALTER COLUMN) instead.
 */
export class AlterBlueprint extends BlueprintBase {
    public readonly addedColumns: ColumnSchema[] = [];
    public readonly modifiedColumns: ColumnSchema[] = [];
    public readonly droppedColumns: string[] = [];
    public readonly renamedColumns: { from: string; to: string }[] = [];
    public readonly addedIndexes: IndexSchema[] = [];
    public readonly droppedIndexes: string[] = [];
    public readonly addedForeignKeys: ForeignKeySchema[] = [];
    public readonly droppedForeignKeys: string[] = [];
    public newPrimaryKey?: string[];
    public dropsPrimaryKey = false;

    protected addColumnImpl(col: ColumnSchema): ColumnDefinition {
        this.addedColumns.push(col);
        return new ColumnDefinition(this, col);
    }

    protected addIndexImpl(idx: IndexSchema): void {
        this.addedIndexes.push(idx);
    }

    protected addForeignKeyImpl(fk: ForeignKeySchema): void {
        this.addedForeignKeys.push(fk);
    }

    dropColumn(name: string): this {
        this.droppedColumns.push(name);
        return this;
    }

    renameColumn(from: string, to: string): this {
        this.renamedColumns.push({ from, to });
        return this;
    }

    /** Drop an index by name. */
    dropIndex(name: string): this {
        this.droppedIndexes.push(name);
        return this;
    }

    /** Alias of dropIndex — same op at the SQL level, kept for readability. */
    dropUnique(name: string): this {
        return this.dropIndex(name);
    }

    /** Drop a foreign key constraint by name. */
    dropForeign(name: string): this {
        this.droppedForeignKeys.push(name);
        return this;
    }

    /** Set / replace the table's primary key. */
    primary(columns: string[]): this {
        this.newPrimaryKey = columns;
        return this;
    }

    /** Drop the existing primary key. Combine with `.primary([...])` to replace. */
    dropPrimary(): this {
        this.dropsPrimaryKey = true;
        return this;
    }

    /** Called by ColumnDefinition.change() — moves a column from added → modified. */
    markColumnAsModified(col: ColumnSchema): void {
        const idx = this.addedColumns.indexOf(col);
        if (idx >= 0) {
            this.addedColumns.splice(idx, 1);
            this.modifiedColumns.push(col);
        }
    }
}
