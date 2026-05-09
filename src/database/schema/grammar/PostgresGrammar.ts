import { Dialect, quoteId } from '../../dialect';
import { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../migration/create/schema-model';
import { escapeStr, Grammar, validateFkAction } from './Grammar';

export class PostgresGrammar extends Grammar {
    readonly dialect: Dialect = 'postgres';

    quote(name: string): string {
        return quoteId('postgres', name);
    }

    qualifiedTable(name: string): string {
        if (this.pgSchema && this.pgSchema !== 'public') {
            return `${this.quote(this.pgSchema)}.${this.quote(name)}`;
        }
        return this.quote(name);
    }

    qualifiedType(typeName: string): string {
        if (this.pgSchema && this.pgSchema !== 'public') {
            return `${this.quote(this.pgSchema)}.${this.quote(typeName)}`;
        }
        return this.quote(typeName);
    }

    createTable(table: TableSchema): string {
        const lines: string[] = [];
        const pkCols = table.columns.filter(c => c.isPrimaryKey).map(c => c.name);

        for (const col of table.columns) {
            lines.push(`    ${this.columnDef(col)}`);
        }

        if (pkCols.length > 0) {
            const quoted = pkCols.map(c => this.quote(c)).join(', ');
            lines.push(`    PRIMARY KEY (${quoted})`);
        }

        return `CREATE TABLE ${this.qualifiedTable(table.name)} (\n${lines.join(',\n')}\n)`;
    }

    createIndex(tableName: string, idx: IndexSchema): string {
        const unique = idx.unique ? 'UNIQUE ' : '';
        // PG has no SPATIAL prefix; spatial flag is silently ignored
        const cols = idx.columns.map(c => this.quote(c)).join(', ');
        return `CREATE ${unique}INDEX ${this.quote(idx.name)} ON ${this.qualifiedTable(tableName)} (${cols})`;
    }

    addForeignKey(tableName: string, fk: ForeignKeySchema): string {
        const cols = fk.columns.map(c => this.quote(c)).join(', ');
        const refCols = fk.referencedColumns.map(c => this.quote(c)).join(', ');
        const onDelete = validateFkAction(fk.onDelete, this.dialect);
        const onUpdate = validateFkAction(fk.onUpdate, this.dialect);
        return (
            `ALTER TABLE ${this.qualifiedTable(tableName)} ADD CONSTRAINT ${this.quote(fk.name)} ` +
            `FOREIGN KEY (${cols}) REFERENCES ${this.qualifiedTable(fk.referencedTable)} (${refCols}) ` +
            `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
        );
    }

    createEnumType(typeName: string, values: string[]): string[] {
        const qualifiedName = this.qualifiedType(typeName);
        const vals = values.map(v => `'${escapeStr(v)}'`).join(', ');
        const schemaFilter =
            this.pgSchema && this.pgSchema !== 'public'
                ? ` AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${escapeStr(this.pgSchema)}')`
                : '';
        return [
            [
                `DO $$ BEGIN`,
                `IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${escapeStr(typeName)}'${schemaFilter}) THEN`,
                `    CREATE TYPE ${qualifiedName} AS ENUM (${vals});`,
                `END IF;`,
                `END $$`
            ].join('\n'),
            `CREATE CAST (text AS ${qualifiedName}) WITH INOUT AS IMPLICIT`
        ];
    }

    dropTable(name: string): string {
        return `DROP TABLE ${this.qualifiedTable(name)}`;
    }

    dropTableIfExists(name: string): string {
        return `DROP TABLE IF EXISTS ${this.qualifiedTable(name)}`;
    }

    renameTable(from: string, to: string): string {
        return `ALTER TABLE ${this.qualifiedTable(from)} RENAME TO ${this.quote(to)}`;
    }

    addColumn(tableName: string, col: ColumnSchema): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} ADD COLUMN ${this.columnDef(col)}`;
    }

    dropColumn(tableName: string, columnName: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} DROP COLUMN ${this.quote(columnName)}`;
    }

    modifyColumn(tableName: string, col: ColumnSchema): string[] {
        const stmts: string[] = [];
        const tbl = this.qualifiedTable(tableName);
        const c = this.quote(col.name);

        const typeDef = col.autoIncrement ? (col.type === 'bigint' ? 'BIGINT' : 'INTEGER') : this.typeDef(col);
        stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${c} TYPE ${typeDef}`);
        stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${c} ${col.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
        if (col.defaultExpression) {
            stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${c} SET DEFAULT ${col.defaultExpression}`);
        } else if (col.defaultValue !== undefined) {
            stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${c} SET DEFAULT ${renderPgDefault(col)}`);
        } else {
            stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${c} DROP DEFAULT`);
        }
        return stmts;
    }

    renameColumn(tableName: string, from: string, to: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} RENAME COLUMN ${this.quote(from)} TO ${this.quote(to)}`;
    }

    dropIndex(tableName: string, indexName: string): string {
        // Index names in PG are schema-qualified, not table-qualified
        if (this.pgSchema && this.pgSchema !== 'public') {
            return `DROP INDEX ${this.quote(this.pgSchema)}.${this.quote(indexName)}`;
        }
        return `DROP INDEX ${this.quote(indexName)}`;
    }

    dropForeignKey(tableName: string, constraintName: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} DROP CONSTRAINT ${this.quote(constraintName)}`;
    }

    addPrimaryKey(tableName: string, columns: string[]): string {
        const cols = columns.map(c => this.quote(c)).join(', ');
        return `ALTER TABLE ${this.qualifiedTable(tableName)} ADD PRIMARY KEY (${cols})`;
    }

    dropPrimaryKey(tableName: string, constraintName?: string): string {
        const name = constraintName ?? `${tableName}_pkey`;
        return `ALTER TABLE ${this.qualifiedTable(tableName)} DROP CONSTRAINT ${this.quote(name)}`;
    }

    columnType(col: ColumnSchema): string {
        return this.typeDef(col);
    }

    columnDef(col: ColumnSchema): string {
        let typeDef: string;
        if (col.autoIncrement) {
            typeDef = col.type === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
        } else {
            typeDef = this.typeDef(col);
        }

        let def = `${this.quote(col.name)} ${typeDef}`;

        if (!col.nullable && !col.autoIncrement) def += ' NOT NULL';

        if (!col.autoIncrement) {
            if (col.defaultExpression) {
                def += ` DEFAULT ${col.defaultExpression}`;
            } else if (col.defaultValue !== undefined) {
                def += ` DEFAULT ${renderPgDefault(col)}`;
            }
        }

        return def;
    }

    private typeDef(col: ColumnSchema): string {
        switch (col.type) {
            case 'varchar':
                return col.size ? `VARCHAR(${col.size})` : 'VARCHAR';
            case 'char':
                return `CHAR(${col.size || 1})`;
            case 'smallint':
                return 'SMALLINT';
            case 'int':
            case 'integer':
                return 'INTEGER';
            case 'bigint':
                return 'BIGINT';
            case 'real':
            case 'float':
                return 'REAL';
            case 'double precision':
            case 'double':
                return 'DOUBLE PRECISION';
            case 'decimal':
            case 'numeric':
                if (col.size === undefined) return 'NUMERIC';
                return col.scale !== undefined ? `NUMERIC(${col.size},${col.scale})` : `NUMERIC(${col.size})`;
            case 'boolean':
                return 'BOOLEAN';
            case 'date':
                return 'DATE';
            case 'timestamp':
                return 'TIMESTAMP';
            case 'timestamptz':
                return 'TIMESTAMPTZ';
            case 'text':
                return 'TEXT';
            case 'bytea':
                return 'BYTEA';
            case 'json':
                return 'JSON';
            case 'jsonb':
                return 'JSONB';
            case 'uuid':
                return 'UUID';
            case 'enum':
                return col.enumTypeName ? this.qualifiedType(col.enumTypeName) : 'TEXT';
            default:
                return col.type.toUpperCase();
        }
    }
}

const PG_NUMERIC_TYPES = new Set(['smallint', 'int', 'integer', 'bigint', 'real', 'float', 'double', 'double precision', 'decimal', 'numeric']);

function renderPgDefault(col: ColumnSchema): string {
    const v = col.defaultValue;
    if (v === null) return 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (col.type === 'boolean') {
        const s = String(v).toLowerCase();
        return s === 'true' || s === '1' ? 'TRUE' : 'FALSE';
    }
    if (typeof v === 'number' || PG_NUMERIC_TYPES.has(col.type)) return String(v);
    return `'${escapeStr(String(v))}'`;
}
