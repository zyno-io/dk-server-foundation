import { Dialect, quoteId } from '../../dialect';
import { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../migration/create/schema-model';
import { escapeStr, Grammar, validateFkAction } from './Grammar';

export class MySQLGrammar extends Grammar {
    readonly dialect: Dialect = 'mysql';

    quote(name: string): string {
        return quoteId('mysql', name);
    }

    qualifiedTable(name: string): string {
        return this.quote(name);
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
        const spatial = idx.spatial ? 'SPATIAL ' : '';
        const cols = idx.columns.map(c => this.quote(c)).join(', ');
        return `CREATE ${spatial}${unique}INDEX ${this.quote(idx.name)} ON ${this.qualifiedTable(tableName)} (${cols})`;
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

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    createEnumType(_typeName: string, _values: string[]): string[] {
        return [];
    }

    dropTable(name: string): string {
        return `DROP TABLE ${this.qualifiedTable(name)}`;
    }

    dropTableIfExists(name: string): string {
        return `DROP TABLE IF EXISTS ${this.qualifiedTable(name)}`;
    }

    renameTable(from: string, to: string): string {
        return `RENAME TABLE ${this.qualifiedTable(from)} TO ${this.qualifiedTable(to)}`;
    }

    addColumn(tableName: string, col: ColumnSchema): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} ADD COLUMN ${this.columnDef(col)}${this.positionClause(col)}`;
    }

    private positionClause(col: ColumnSchema): string {
        if (col.afterColumn === null) return ' FIRST';
        if (typeof col.afterColumn === 'string') return ` AFTER ${this.quote(col.afterColumn)}`;
        return '';
    }

    dropColumn(tableName: string, columnName: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} DROP COLUMN ${this.quote(columnName)}`;
    }

    modifyColumn(tableName: string, col: ColumnSchema): string[] {
        return [`ALTER TABLE ${this.qualifiedTable(tableName)} MODIFY COLUMN ${this.columnDef(col)}`];
    }

    renameColumn(tableName: string, from: string, to: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} RENAME COLUMN ${this.quote(from)} TO ${this.quote(to)}`;
    }

    dropIndex(tableName: string, indexName: string): string {
        return `DROP INDEX ${this.quote(indexName)} ON ${this.qualifiedTable(tableName)}`;
    }

    dropForeignKey(tableName: string, constraintName: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} DROP FOREIGN KEY ${this.quote(constraintName)}`;
    }

    addPrimaryKey(tableName: string, columns: string[]): string {
        const cols = columns.map(c => this.quote(c)).join(', ');
        return `ALTER TABLE ${this.qualifiedTable(tableName)} ADD PRIMARY KEY (${cols})`;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    dropPrimaryKey(tableName: string, _constraintName?: string): string {
        return `ALTER TABLE ${this.qualifiedTable(tableName)} DROP PRIMARY KEY`;
    }

    columnDef(col: ColumnSchema): string {
        let def = `${this.quote(col.name)} ${this.typeDef(col)}`;

        if (col.unsigned) def += ' UNSIGNED';
        if (!col.nullable) def += ' NOT NULL';
        if (col.autoIncrement) def += ' AUTO_INCREMENT';

        if (col.defaultExpression) {
            def += ` DEFAULT ${col.defaultExpression}`;
        } else if (col.defaultValue !== undefined) {
            def += ` DEFAULT ${renderMysqlDefault(col)}`;
        }

        if (col.onUpdateExpression) {
            def += ` ON UPDATE ${col.onUpdateExpression}`;
        }

        return def;
    }

    columnType(col: ColumnSchema): string {
        return this.typeDef(col);
    }

    private typeDef(col: ColumnSchema): string {
        switch (col.type) {
            case 'varchar':
                return `VARCHAR(${col.size || 255})`;
            case 'char':
                return `CHAR(${col.size || 1})`;
            case 'tinyint':
                return col.size === 1 ? 'TINYINT(1)' : 'TINYINT';
            case 'smallint':
                return 'SMALLINT';
            case 'int':
                return 'INT';
            case 'bigint':
                return 'BIGINT';
            case 'float':
                return 'FLOAT';
            case 'double':
                return 'DOUBLE';
            case 'decimal':
                if (col.size === undefined) return 'DECIMAL';
                return col.scale !== undefined ? `DECIMAL(${col.size},${col.scale})` : `DECIMAL(${col.size})`;
            case 'boolean':
                return 'TINYINT(1)';
            case 'date':
                return 'DATE';
            case 'datetime':
                return 'DATETIME';
            case 'timestamp':
                return 'TIMESTAMP';
            case 'text':
                return 'TEXT';
            case 'binary':
                return `BINARY(${col.size || 16})`;
            case 'blob':
                return 'BLOB';
            case 'json':
                return 'JSON';
            case 'point':
                return 'POINT';
            case 'enum':
                if (col.enumValues) {
                    const vals = col.enumValues.map(v => `'${escapeStr(v, 'mysql')}'`).join(',');
                    return `ENUM(${vals})`;
                }
                return 'VARCHAR(255)';
            default:
                return col.type.toUpperCase();
        }
    }
}

const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'int', 'integer', 'bigint', 'float', 'double', 'decimal', 'numeric']);

function renderMysqlDefault(col: ColumnSchema): string {
    const v = col.defaultValue;
    if (v === null) return 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    // tinyint(1)/boolean — entity-reader may pre-format as '1'/'0'/'true'/'false'
    if (col.type === 'boolean' || (col.type === 'tinyint' && col.size === 1)) {
        const s = String(v).toLowerCase();
        return s === 'true' || s === '1' ? '1' : '0';
    }
    if (typeof v === 'number' || NUMERIC_TYPES.has(col.type)) return String(v);
    return `'${escapeStr(String(v), 'mysql')}'`;
}
