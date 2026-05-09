import { Dialect } from '../../dialect';
import { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../migration/create/schema-model';

export abstract class Grammar {
    abstract readonly dialect: Dialect;

    constructor(public readonly pgSchema: string = 'public') {}

    abstract quote(name: string): string;
    abstract qualifiedTable(name: string): string;

    abstract createTable(table: TableSchema): string;
    abstract createIndex(tableName: string, idx: IndexSchema): string;
    abstract addForeignKey(tableName: string, fk: ForeignKeySchema): string;

    /** Emits any per-enum-type DDL (PG: CREATE TYPE + CREATE CAST). MySQL returns []. */
    abstract createEnumType(typeName: string, values: string[]): string[];

    abstract dropTable(name: string): string;
    abstract dropTableIfExists(name: string): string;
    abstract renameTable(from: string, to: string): string;

    /** Render one column line for use inside CREATE TABLE. */
    abstract columnDef(col: ColumnSchema): string;

    /** Render just the type portion (e.g. `VARCHAR(255)`, `BOOLEAN`, `BIGINT`) without modifiers. */
    abstract columnType(col: ColumnSchema): string;

    // --- ALTER TABLE emitters ---

    abstract addColumn(tableName: string, col: ColumnSchema): string;
    abstract dropColumn(tableName: string, columnName: string): string;
    /** Modify an existing column. PG may emit multiple statements (one per attribute change). */
    abstract modifyColumn(tableName: string, col: ColumnSchema): string[];
    abstract renameColumn(tableName: string, from: string, to: string): string;
    abstract dropIndex(tableName: string, indexName: string): string;
    abstract dropForeignKey(tableName: string, constraintName: string): string;
    abstract addPrimaryKey(tableName: string, columns: string[]): string;
    /** Drop the existing primary key. PG needs the constraint name; defaults to `${table}_pkey`. */
    abstract dropPrimaryKey(tableName: string, constraintName?: string): string;
}

const VALID_FK_ACTIONS = new Set(['RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'NO ACTION']);

export function validateFkAction(action: string, dialect: Dialect): string {
    const upper = action.toUpperCase();
    if (!VALID_FK_ACTIONS.has(upper)) {
        throw new Error(`Invalid foreign key action: '${action}'`);
    }
    if (upper === 'SET DEFAULT' && dialect === 'mysql') {
        throw new Error(`Foreign key action 'SET DEFAULT' is not supported by MySQL/InnoDB`);
    }
    return upper;
}

export function escapeStr(s: string, dialect?: Dialect): string {
    if (dialect === 'mysql') {
        s = s.replace(/\\/g, '\\\\');
    }
    return s.replace(/'/g, "''");
}
