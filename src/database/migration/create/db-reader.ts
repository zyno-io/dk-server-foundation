import { sql } from '@deepkit/sql';

import { BaseDatabase } from '../../common';
import { quoteId } from '../../dialect';
import { ColumnSchema, DatabaseSchema, Dialect, IndexSchema, ForeignKeySchema, TableSchema } from './schema-model';

export async function readAllTableNames(db: BaseDatabase, dialect: Dialect, pgSchema: string = 'public'): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];
    if (dialect === 'mysql') {
        rows = await db.rawQuery(
            sql`SELECT TABLE_NAME FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
        );
        return rows.map(r => r.TABLE_NAME);
    } else {
        rows = await db.rawQuery(sql`SELECT tablename FROM pg_tables WHERE schemaname = ${pgSchema}`);
        return rows.map(r => r.tablename);
    }
}

export async function readDatabaseSchema(
    db: BaseDatabase,
    dialect: Dialect,
    tableNames: string[],
    pgSchema: string = 'public'
): Promise<DatabaseSchema> {
    const schema: DatabaseSchema = new Map();

    for (const tableName of tableNames) {
        try {
            const table = dialect === 'mysql' ? await readMySQLTable(db, tableName) : await readPostgresTable(db, tableName, pgSchema);
            if (table) {
                schema.set(tableName, table);
            }
        } catch (err) {
            throw new Error(`Failed to read schema for table '${tableName}': ${err instanceof Error ? err.message : err}`);
        }
    }

    return schema;
}

// --- MySQL ---

async function readMySQLTable(db: BaseDatabase, tableName: string): Promise<TableSchema | null> {
    const columns = await readMySQLColumns(db, tableName);
    if (columns.length === 0) return null;

    const indexes = await readMySQLIndexes(db, tableName);
    const foreignKeys = await readMySQLForeignKeys(db, tableName);

    return { name: tableName, columns, indexes, foreignKeys };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readMySQLColumns(db: BaseDatabase, tableName: string): Promise<ColumnSchema[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(
        sql`SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE,
                DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION, NUMERIC_SCALE, EXTRA, COLUMN_KEY
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}
         ORDER BY ORDINAL_POSITION`
    );

    return rows.map(row => {
        const columnType = (row.COLUMN_TYPE || '').toLowerCase();
        const dataType = (row.DATA_TYPE || '').toLowerCase();
        const extra = (row.EXTRA || '').toLowerCase();

        const col: ColumnSchema = {
            name: row.COLUMN_NAME,
            type: normalizeMySQLType(dataType, columnType),
            size: inferMySQLSize(dataType, columnType, row.CHARACTER_MAXIMUM_LENGTH, row.NUMERIC_PRECISION),
            scale: row.NUMERIC_SCALE != null ? Number(row.NUMERIC_SCALE) : undefined,
            unsigned: columnType.includes('unsigned'),
            nullable: row.IS_NULLABLE === 'YES',
            autoIncrement: extra.includes('auto_increment'),
            isPrimaryKey: row.COLUMN_KEY === 'PRI',
            ordinalPosition: Number(row.ORDINAL_POSITION)
        };

        // Parse enum values
        if (dataType === 'enum') {
            col.enumValues = parseEnumValues(columnType);
        }

        // Default value
        if (row.COLUMN_DEFAULT != null && !col.autoIncrement) {
            const def = String(row.COLUMN_DEFAULT);
            if (isExpression(def)) {
                col.defaultExpression = def;
            } else {
                col.defaultValue = def;
            }
        }

        // ON UPDATE expression
        if (extra.includes('on update')) {
            const match = extra.match(/on update\s+(.+)/i);
            if (match) {
                col.onUpdateExpression = match[1].toUpperCase();
            }
        }

        return col;
    });
}

async function readMySQLIndexes(db: BaseDatabase, tableName: string): Promise<IndexSchema[]> {
    // SHOW INDEX requires an identifier, not a parameter — use quoteId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(`SHOW INDEX FROM ${quoteId('mysql', tableName)}`);

    const indexMap = new Map<string, { schema: IndexSchema; columnsBySeq: { seq: number; name: string }[] }>();
    for (const row of rows) {
        const keyName = row.Key_name;
        if (keyName === 'PRIMARY') continue; // PK is handled separately

        if (!indexMap.has(keyName)) {
            indexMap.set(keyName, {
                schema: {
                    name: keyName,
                    columns: [],
                    unique: row.Non_unique === 0,
                    spatial: (row.Index_type || '').toUpperCase() === 'SPATIAL'
                },
                columnsBySeq: []
            });
        }
        indexMap.get(keyName)!.columnsBySeq.push({ seq: Number(row.Seq_in_index), name: row.Column_name });
    }

    // Sort columns by Seq_in_index to ensure correct multi-column index order
    for (const entry of indexMap.values()) {
        entry.columnsBySeq.sort((a, b) => a.seq - b.seq);
        entry.schema.columns = entry.columnsBySeq.map(c => c.name);
    }

    return Array.from(indexMap.values()).map(e => e.schema);
}

async function readMySQLForeignKeys(db: BaseDatabase, tableName: string): Promise<ForeignKeySchema[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(
        sql`SELECT
            kcu.CONSTRAINT_NAME,
            kcu.COLUMN_NAME,
            kcu.REFERENCED_TABLE_NAME,
            kcu.REFERENCED_COLUMN_NAME,
            rc.DELETE_RULE,
            rc.UPDATE_RULE
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
            ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
            AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
         WHERE kcu.TABLE_SCHEMA = DATABASE()
            AND kcu.TABLE_NAME = ${tableName}
            AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`
    );

    const fkMap = new Map<string, ForeignKeySchema>();
    for (const row of rows) {
        const name = row.CONSTRAINT_NAME;
        if (!fkMap.has(name)) {
            fkMap.set(name, {
                name,
                columns: [],
                referencedTable: row.REFERENCED_TABLE_NAME,
                referencedColumns: [],
                onDelete: (row.DELETE_RULE || 'RESTRICT').toUpperCase(),
                onUpdate: (row.UPDATE_RULE || 'RESTRICT').toUpperCase()
            });
        }
        const fk = fkMap.get(name)!;
        fk.columns.push(row.COLUMN_NAME);
        fk.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
    }

    return Array.from(fkMap.values());
}

// --- PostgreSQL ---

async function readPostgresTable(db: BaseDatabase, tableName: string, pgSchema: string = 'public'): Promise<TableSchema | null> {
    const columns = await readPostgresColumns(db, tableName, pgSchema);
    if (columns.length === 0) return null;

    const indexes = await readPostgresIndexes(db, tableName, pgSchema);
    const foreignKeys = await readPostgresForeignKeys(db, tableName, pgSchema);

    // Read PK constraint name
    let primaryKeyConstraintName: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkConstraintRows: any[] = await db.rawQuery(
        sql`SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = ${pgSchema} AND table_name = ${tableName}
            AND constraint_type = 'PRIMARY KEY'`
    );
    if (pkConstraintRows.length > 0) {
        primaryKeyConstraintName = pkConstraintRows[0].constraint_name;
    }

    return { name: tableName, columns, indexes, foreignKeys, primaryKeyConstraintName };
}

async function readPostgresColumns(db: BaseDatabase, tableName: string, pgSchema: string = 'public'): Promise<ColumnSchema[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(
        sql`SELECT column_name, ordinal_position, column_default, is_nullable,
                data_type, udt_name, character_maximum_length,
                numeric_precision, numeric_scale, is_identity,
                identity_generation
         FROM information_schema.columns
         WHERE table_schema = ${pgSchema} AND table_name = ${tableName}
         ORDER BY ordinal_position`
    );

    const columns: ColumnSchema[] = [];

    for (const row of rows) {
        const dataType = normalizePostgresType(row.data_type, row.udt_name);
        const isIdentity = row.is_identity === 'YES';
        const isSerial = (row.column_default && String(row.column_default).includes('nextval(')) || isIdentity;

        const col: ColumnSchema = {
            name: row.column_name,
            type: dataType,
            size: inferPostgresSize(dataType, row.character_maximum_length, row.numeric_precision),
            scale: row.numeric_scale != null ? Number(row.numeric_scale) : undefined,
            unsigned: false,
            nullable: row.is_nullable === 'YES',
            autoIncrement: isSerial,
            isPrimaryKey: false, // resolved below from PK constraint
            isIdentity,
            ordinalPosition: Number(row.ordinal_position)
        };

        // Resolve actual sequence name for serial columns
        if (isSerial && !isIdentity) {
            const qualifiedTable = `${pgSchema}.${tableName}`;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const seqRows: any[] = await db.rawQuery(sql`SELECT pg_get_serial_sequence(${qualifiedTable}, ${row.column_name}) as seq_name`);
            if (seqRows.length > 0 && seqRows[0].seq_name) {
                col.sequenceName = seqRows[0].seq_name;
            }
        }

        // Enum type — only classify as enum if enum values exist;
        // other USER-DEFINED types (citext, ltree, PostGIS) are left as-is
        if (row.data_type === 'USER-DEFINED') {
            const enumValues = await readPostgresEnumValues(db, row.udt_name, pgSchema);
            if (enumValues.length > 0) {
                col.type = 'enum';
                col.enumTypeName = row.udt_name;
                col.enumValues = enumValues;
            }
        }

        // Default
        if (row.column_default != null && !isSerial) {
            const def = String(row.column_default);
            // Strip type casts like ::text, ::character varying, or chained casts like ::character varying::text
            const cleaned = def.replace(/(::[\w ]+)+$/i, '').trim();
            if (isExpression(cleaned)) {
                col.defaultExpression = cleaned;
            } else {
                // Remove surrounding quotes from string defaults
                col.defaultValue = cleaned.replace(/^'(.*)'$/, '$1');
            }
        }

        columns.push(col);
    }

    // Resolve primary keys
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkRows: any[] = await db.rawQuery(
        sql`SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = ${pgSchema}
            AND tc.table_name = ${tableName}
         ORDER BY kcu.ordinal_position`
    );
    const pkCols = new Set(pkRows.map(r => r.column_name));
    for (const col of columns) {
        if (pkCols.has(col.name)) col.isPrimaryKey = true;
    }

    return columns;
}

async function readPostgresEnumValues(db: BaseDatabase, typeName: string, pgSchema: string = 'public'): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(
        sql`SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = ${typeName}
            AND n.nspname = ${pgSchema}
         ORDER BY e.enumsortorder`
    );
    return rows.map(r => r.enumlabel);
}

async function readPostgresIndexes(db: BaseDatabase, tableName: string, pgSchema: string = 'public'): Promise<IndexSchema[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(
        sql`SELECT
            i.relname AS index_name,
            ix.indisunique AS is_unique,
            array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE n.nspname = ${pgSchema}
            AND t.relname = ${tableName}
            AND NOT ix.indisprimary
         GROUP BY i.relname, ix.indisunique`
    );

    return rows.map(row => ({
        name: row.index_name,
        columns: Array.isArray(row.columns) ? row.columns : [row.columns],
        unique: row.is_unique,
        spatial: false
    }));
}

async function readPostgresForeignKeys(db: BaseDatabase, tableName: string, pgSchema: string = 'public'): Promise<ForeignKeySchema[]> {
    // Use pg_constraint to correctly pair multi-column FK columns via conkey/confkey arrays
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await db.rawQuery(
        sql`SELECT
            c.conname AS constraint_name,
            array_agg(a_src.attname ORDER BY key_idx.ord) AS columns,
            ref_cls.relname AS referenced_table,
            array_agg(a_ref.attname ORDER BY key_idx.ord) AS referenced_columns,
            CASE c.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' ELSE 'RESTRICT'
            END AS delete_rule,
            CASE c.confupdtype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' ELSE 'RESTRICT'
            END AS update_rule
         FROM pg_constraint c
         JOIN pg_class src_cls ON src_cls.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = src_cls.relnamespace
         JOIN pg_class ref_cls ON ref_cls.oid = c.confrelid
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS key_idx(src_attnum, ref_attnum, ord)
         JOIN pg_attribute a_src ON a_src.attrelid = c.conrelid AND a_src.attnum = key_idx.src_attnum
         JOIN pg_attribute a_ref ON a_ref.attrelid = c.confrelid AND a_ref.attnum = key_idx.ref_attnum
         WHERE c.contype = 'f'
            AND n.nspname = ${pgSchema}
            AND src_cls.relname = ${tableName}
         GROUP BY c.conname, ref_cls.relname, c.confdeltype, c.confupdtype`
    );

    return rows.map(row => ({
        name: row.constraint_name,
        columns: Array.isArray(row.columns) ? row.columns : [row.columns],
        referencedTable: row.referenced_table,
        referencedColumns: Array.isArray(row.referenced_columns) ? row.referenced_columns : [row.referenced_columns],
        onDelete: (row.delete_rule || 'RESTRICT').toUpperCase(),
        onUpdate: (row.update_rule || 'RESTRICT').toUpperCase()
    }));
}

// --- Helpers ---

function normalizeMySQLType(dataType: string, columnType: string): string {
    // Keep tinyint(1) for boolean detection
    if (dataType === 'tinyint' && columnType.startsWith('tinyint(1)')) {
        return 'tinyint';
    }
    // Strip display widths: int(11) → int
    return dataType;
}

function inferMySQLSize(dataType: string, columnType: string, charMaxLen: number | null, numPrecision: number | null): number | undefined {
    if (dataType === 'varchar' || dataType === 'char') {
        return charMaxLen != null ? Number(charMaxLen) : undefined;
    }
    if (dataType === 'tinyint' && columnType.startsWith('tinyint(1)')) {
        return 1;
    }
    if (dataType === 'binary') {
        return charMaxLen != null ? Number(charMaxLen) : undefined;
    }
    if (dataType === 'decimal' || dataType === 'numeric') {
        return numPrecision != null ? Number(numPrecision) : undefined;
    }
    return undefined;
}

function normalizePostgresType(dataType: string, udtName: string): string {
    switch (dataType) {
        case 'character varying':
            return 'varchar';
        case 'character':
            return 'char';
        case 'integer':
            return 'int';
        case 'timestamp without time zone':
            return 'timestamp';
        case 'timestamp with time zone':
            return 'timestamptz';
        case 'boolean':
            return 'boolean';
        case 'double precision':
            return 'double precision';
        case 'real':
            return 'real';
        case 'smallint':
            return 'smallint';
        case 'bigint':
            return 'bigint';
        case 'text':
            return 'text';
        case 'json':
            return 'json';
        case 'jsonb':
            return 'jsonb';
        case 'uuid':
            return 'uuid';
        case 'bytea':
            return 'bytea';
        case 'date':
            return 'date';
        case 'USER-DEFINED':
            return udtName; // will be resolved to 'enum' by caller
        case 'ARRAY':
            return 'jsonb'; // arrays stored as jsonb
        default:
            return dataType;
    }
}

function inferPostgresSize(dataType: string, charMaxLen: number | null, numPrecision: number | null): number | undefined {
    if (dataType === 'varchar' || dataType === 'char') {
        return charMaxLen != null ? Number(charMaxLen) : undefined;
    }
    if (dataType === 'decimal' || dataType === 'numeric') {
        return numPrecision != null ? Number(numPrecision) : undefined;
    }
    return undefined;
}

function parseEnumValues(columnType: string): string[] {
    // Parse enum('value1','value2','value3') — handles escaped quotes within values
    const match = columnType.match(/^enum\((.+)\)$/i);
    if (!match) return [];

    const inner = match[1];
    const values: string[] = [];
    let i = 0;
    while (i < inner.length) {
        // Skip whitespace
        while (i < inner.length && inner[i] === ' ') i++;
        if (i >= inner.length) break;

        if (inner[i] === "'") {
            i++; // skip opening quote
            let val = '';
            while (i < inner.length) {
                if (inner[i] === '\\' && i + 1 < inner.length) {
                    // Backslash-escaped character
                    val += inner[i + 1];
                    i += 2;
                } else if (inner[i] === "'" && i + 1 < inner.length && inner[i + 1] === "'") {
                    val += "'";
                    i += 2; // skip doubled quote
                } else if (inner[i] === "'") {
                    i++; // skip closing quote
                    break;
                } else {
                    val += inner[i];
                    i++;
                }
            }
            values.push(val);
        }

        // Skip comma
        while (i < inner.length && (inner[i] === ',' || inner[i] === ' ')) i++;
    }
    return values;
}

function isExpression(value: string): boolean {
    const upper = value.toUpperCase().trim();
    return (
        /\bCURRENT_TIMESTAMP\b/.test(upper) ||
        /\bNOW\s*\(\)/.test(upper) ||
        /\bCURRENT_DATE\b/.test(upper) ||
        /\bUUID\s*\(\)/.test(upper) ||
        /\bGEN_RANDOM_UUID\s*\(\)/.test(upper) ||
        /\bNEXTVAL\s*\(/.test(upper)
    );
}
