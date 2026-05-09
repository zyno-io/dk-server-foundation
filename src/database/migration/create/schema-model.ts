import { Dialect } from '../../dialect';

export { Dialect };

/** Tables managed internally by the framework — excluded from migration diff. */
export const INTERNAL_TABLES = new Set(['_migrations', '_locks', '_jobs']);

export interface ColumnSchema {
    name: string;
    type: string; // canonical lowercase: 'varchar', 'int', 'enum', 'point', 'date', 'text', 'boolean', 'timestamp', etc.
    size?: number; // e.g. 255 for varchar(255)
    scale?: number; // e.g. 2 for decimal(10,2)
    unsigned: boolean; // MySQL only; always false for PG
    nullable: boolean;
    autoIncrement: boolean;
    isPrimaryKey: boolean;
    defaultValue?: unknown;
    defaultExpression?: string; // e.g. 'CURRENT_TIMESTAMP', 'NOW()'
    onUpdateExpression?: string; // MySQL only; e.g. 'CURRENT_TIMESTAMP'
    enumValues?: string[]; // ordered values for ENUM type
    enumTypeName?: string; // PG only: name of the enum type
    isIdentity?: boolean; // PG only: true if GENERATED ... AS IDENTITY (vs sequence-backed serial)
    sequenceName?: string; // PG only: actual sequence name from pg_get_serial_sequence()
    ordinalPosition: number; // 1-based column order
    /** MySQL only — positioning hint for ALTER TABLE ADD COLUMN. `null` = FIRST, string = AFTER <col>, undefined = no clause. */
    afterColumn?: string | null;
}

export interface IndexSchema {
    name: string;
    columns: string[]; // ordered
    unique: boolean;
    spatial: boolean; // MySQL only
}

export interface ForeignKeySchema {
    name: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
    onDelete: string;
    onUpdate: string;
}

export interface TableSchema {
    name: string;
    columns: ColumnSchema[]; // in ordinal order
    indexes: IndexSchema[];
    foreignKeys: ForeignKeySchema[];
    primaryKeyConstraintName?: string; // PG only: actual constraint name from DB
    skippedColumns?: Set<string>; // columns the entity-reader couldn't resolve (should not be diffed)
}

export type DatabaseSchema = Map<string, TableSchema>;

// --- Diff types ---

export interface SchemaDiff {
    dialect: Dialect;
    pgSchema?: string; // PG only: schema name for qualified DDL
    addedTables: TableSchema[];
    removedTables: TableSchema[];
    modifiedTables: TableDiff[];
    entityEnumTypes?: Set<string>; // PG only: all enum type names across all entity tables (for safe DROP filtering)
}

export interface TableDiff {
    tableName: string;
    addedColumns: ColumnSchema[];
    removedColumns: ColumnSchema[];
    modifiedColumns: ColumnModification[];
    renamedColumns: { from: string; to: string; column: ColumnSchema }[];
    reorderedColumns: { name: string; after: string | null }[]; // MySQL only; null = FIRST
    addedIndexes: IndexSchema[];
    removedIndexes: IndexSchema[];
    addedForeignKeys: ForeignKeySchema[];
    removedForeignKeys: ForeignKeySchema[];
    primaryKeyChanged: boolean;
    newPrimaryKey?: string[];
    oldPrimaryKey?: string[]; // DB's current PK columns (empty = no existing PK)
    oldPrimaryKeyConstraintName?: string; // PG only: constraint name from DB for DROP
    addedEnumTypes: { typeName: string; values: string[] }[]; // PG only
    removedEnumTypes: string[]; // PG only: old enum type names to DROP
    modifiedEnumTypes: {
        typeName: string;
        added: string[];
        removed: string[];
        newValues: string[];
        tableName: string;
        columnName: string;
    }[]; // PG only
    entityColumns?: ColumnSchema[]; // full entity column list for MySQL reorder DDL
}

export interface ColumnModification {
    name: string;
    oldColumn: ColumnSchema;
    newColumn: ColumnSchema;
    typeChanged: boolean;
    nullableChanged: boolean;
    defaultChanged: boolean;
    autoIncrementChanged: boolean;
    onUpdateChanged: boolean;
}
