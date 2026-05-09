import { ColumnSchema, Dialect, ForeignKeySchema, IndexSchema, SchemaDiff, TableDiff, TableSchema } from './schema-model';

const FILE_HEADER = `import { createMigration } from '@zyno-io/dk-server-foundation';\n\nexport default createMigration(async db => {\n`;
const FILE_FOOTER = `\n});\n`;

/** Render a TypeScript migration file that uses db.schema builder to recreate the given tables. */
export function generateBuilderMigrationFile(tables: TableSchema[]): string {
    const blocks = tables.map(t => renderTableBlock(t));
    return `${FILE_HEADER}${blocks.join('\n\n')}${FILE_FOOTER}`;
}

/**
 * Render a TypeScript migration file from a SchemaDiff. Used by migration:create to emit
 * portable builder-based migrations.
 *
 * Order: drop removed tables → create added tables → alter modified tables. Within an alter:
 * Schema.alter() internally orders operations dependency-safe, so emission order doesn't matter.
 */
export function generateBuilderMigrationFromDiff(diff: SchemaDiff): string {
    const blocks: string[] = [];

    for (const table of diff.removedTables) {
        blocks.push(`    await db.schema.drop(${quoteStr(table.name)});`);
    }

    for (const table of diff.addedTables) {
        blocks.push(renderTableBlock(table));
    }

    for (const tableDiff of diff.modifiedTables) {
        const block = renderAlterBlock(tableDiff, diff.dialect);
        if (block) blocks.push(block);
    }

    if (blocks.length === 0) {
        return `${FILE_HEADER}    // No schema changes detected.${FILE_FOOTER}`;
    }
    return `${FILE_HEADER}${blocks.join('\n\n')}${FILE_FOOTER}`;
}

function renderAlterBlock(td: TableDiff, dialect: Dialect): string {
    const preLines: string[] = [];
    const innerLines: string[] = [];
    const postLines: string[] = [];

    // PG enum lifecycle (raw SQL — first-class builder support is post-Phase-2)
    if (dialect === 'postgres') {
        for (const newType of td.addedEnumTypes) {
            preLines.push(`    await db.schema.enumType(${quoteStr(newType.typeName)}, [${newType.values.map(quoteStr).join(', ')}]);`);
        }
        for (const mod of td.modifiedEnumTypes) {
            for (const value of mod.added) {
                preLines.push(
                    `    await db.schema.raw(${quoteStr(`ALTER TYPE "${mod.typeName}" ADD VALUE IF NOT EXISTS '${value.replace(/'/g, "''")}'`)});`
                );
            }
        }
        for (const typeName of td.removedEnumTypes) {
            postLines.push(`    await db.schema.raw(${quoteStr(`DROP CAST IF EXISTS (text AS "${typeName}")`)});`);
            postLines.push(`    await db.schema.raw(${quoteStr(`DROP TYPE IF EXISTS "${typeName}"`)});`);
        }
    }

    // PK changes (drop existing first, replacement comes via .primary())
    if (td.primaryKeyChanged && td.oldPrimaryKey && td.oldPrimaryKey.length > 0) {
        innerLines.push(`        t.dropPrimary();`);
    }

    for (const fk of td.removedForeignKeys) innerLines.push(`        t.dropForeign(${quoteStr(fk.name)});`);
    for (const idx of td.removedIndexes) innerLines.push(`        t.dropIndex(${quoteStr(idx.name)});`);
    for (const col of td.removedColumns) innerLines.push(`        t.dropColumn(${quoteStr(col.name)});`);
    for (const r of td.renamedColumns) innerLines.push(`        t.renameColumn(${quoteStr(r.from)}, ${quoteStr(r.to)});`);

    const stubTable: TableSchema = { name: td.tableName, columns: [], indexes: [], foreignKeys: [] };

    for (const col of td.addedColumns) {
        let line = renderColumnLine(col, stubTable);
        // MySQL: if we know the entity-order position, emit .after() / .first() to preserve column layout
        if (dialect === 'mysql' && td.entityColumns) {
            const positioning = renderPositioning(col, td.entityColumns, td.addedColumns);
            if (positioning) line = line.replace(/;$/, `${positioning};`);
        }
        innerLines.push(`        ${line}`);
    }
    for (const mod of td.modifiedColumns) {
        // Modified column: render as if adding, append .change()
        const line = renderColumnLine(mod.newColumn, stubTable);
        innerLines.push(`        ${line.replace(/;$/, '.change();')}`);
    }

    if (td.primaryKeyChanged && td.newPrimaryKey && td.newPrimaryKey.length > 0) {
        innerLines.push(`        t.primary([${td.newPrimaryKey.map(quoteStr).join(', ')}]);`);
    }

    for (const idx of td.addedIndexes) innerLines.push(`        ${renderIndexLine(idx, stubTable)}`);
    for (const fk of td.addedForeignKeys) innerLines.push(`        ${renderForeignKeyLine(fk, stubTable)}`);

    if (innerLines.length === 0 && preLines.length === 0 && postLines.length === 0) return '';

    const parts: string[] = [];
    if (preLines.length > 0) parts.push(preLines.join('\n'));
    if (innerLines.length > 0) {
        parts.push(`    await db.schema.alter(${quoteStr(td.tableName)}, t => {\n${innerLines.join('\n')}\n    });`);
    }
    if (postLines.length > 0) parts.push(postLines.join('\n'));
    return parts.join('\n\n');
}

function renderTableBlock(table: TableSchema): string {
    const lines: string[] = [];

    for (const col of table.columns) {
        lines.push(`        ${renderColumnLine(col, table)}`);
    }

    // Composite PK — single-column PK is emitted via .primary() on the column line
    const pkCols = table.columns.filter(c => c.isPrimaryKey).map(c => c.name);
    if (pkCols.length > 1) {
        lines.push(`        t.primary([${pkCols.map(quoteStr).join(', ')}]);`);
    }

    for (const idx of table.indexes) {
        lines.push(`        ${renderIndexLine(idx, table)}`);
    }

    for (const fk of table.foreignKeys) {
        lines.push(`        ${renderForeignKeyLine(fk, table)}`);
    }

    return `    await db.schema.create(${quoteStr(table.name)}, t => {\n${lines.join('\n')}\n    });`;
}

/** Emit `.after('x')` / `.first()` based on entity-order position of an added column. */
function renderPositioning(col: ColumnSchema, entityColumns: ColumnSchema[], addedColumns: ColumnSchema[]): string {
    const idx = entityColumns.findIndex(c => c.name === col.name);
    if (idx < 0) return '';
    const addedNames = new Set(addedColumns.map(c => c.name));
    // Walk backwards to find the previous column that already exists in the DB (not in the same add batch)
    for (let i = idx - 1; i >= 0; i--) {
        const prev = entityColumns[i];
        if (!addedNames.has(prev.name)) return `.after(${quoteStr(prev.name)})`;
    }
    return '.first()';
}

function renderColumnLine(col: ColumnSchema, table: TableSchema): string {
    let line = `t.${pickBuilderMethod(col)}`;

    // Modifier order chosen to read naturally
    if (col.unsigned) line += '.unsigned()';
    if (col.nullable) line += '.nullable()';
    if (col.autoIncrement) line += '.autoIncrement()';

    const pkCount = table.columns.filter(c => c.isPrimaryKey).length;
    if (col.isPrimaryKey && pkCount === 1) line += '.primary()';

    if (col.defaultExpression) {
        line += `.defaultRaw(${quoteStr(col.defaultExpression)})`;
    } else if (col.defaultValue !== undefined) {
        line += `.default(${renderJsValue(col.defaultValue)})`;
    }

    if (col.onUpdateExpression) {
        line += `.onUpdate(${quoteStr(col.onUpdateExpression)})`;
    }

    return line + ';';
}

function pickBuilderMethod(col: ColumnSchema): string {
    const n = quoteStr(col.name);
    switch (col.type) {
        case 'varchar':
            return `string(${n}, ${col.size ?? 255})`;
        case 'char':
            // CHAR(36) is the canonical string-form UUID storage (dksf:uuid annotation)
            if (col.size === 36) return `uuidString(${n})`;
            return `char(${n}, ${col.size ?? 1})`;
        case 'text':
            return `text(${n})`;
        case 'tinyint':
            // tinyint(1) is the canonical MySQL boolean storage; map back to .boolean()
            if (col.size === 1) return `boolean(${n})`;
            return `tinyint(${n})`;
        case 'smallint':
            return `smallint(${n})`;
        case 'int':
        case 'integer':
            return `integer(${n})`;
        case 'bigint':
            return `bigInteger(${n})`;
        case 'boolean':
            return `boolean(${n})`;
        case 'float':
        case 'real':
            return `float(${n})`;
        case 'double':
        case 'double precision':
            return `double(${n})`;
        case 'decimal':
        case 'numeric': {
            const args = [n];
            if (col.size !== undefined) {
                args.push(String(col.size));
                if (col.scale !== undefined) args.push(String(col.scale));
            }
            return `decimal(${args.join(', ')})`;
        }
        case 'date':
            return `date(${n})`;
        case 'datetime':
        case 'timestamp':
            return `dateTime(${n})`;
        case 'timestamptz':
            return `timestamptz(${n})`;
        case 'binary':
            // BINARY(16) is the canonical UUID storage on MySQL (Deepkit's UUIDv4 annotation)
            if (col.size === 16) return `uuid(${n})`;
            return `binary(${n}, ${col.size ?? 16})`;
        case 'blob':
        case 'bytea':
            return `blob(${n})`;
        case 'json':
            return `json(${n})`;
        case 'jsonb':
            return `jsonb(${n})`;
        case 'uuid':
            return `uuid(${n})`;
        case 'point':
            return `point(${n})`;
        case 'enum': {
            const values = col.enumValues ?? [];
            const valuesArg = `[${values.map(v => quoteStr(v)).join(', ')}]`;
            const typeName = col.enumTypeName;
            const args = typeName ? [n, valuesArg, quoteStr(typeName)] : [n, valuesArg];
            return `enum(${args.join(', ')})`;
        }
        default:
            throw new Error(`Unsupported column type for builder regeneration: '${col.type}' (column ${col.name})`);
    }
}

function renderIndexLine(idx: IndexSchema, table: TableSchema): string {
    const colsArg = renderColumnsArg(idx.columns);

    const suffix = idx.spatial ? 'spatial' : idx.unique ? 'unique' : 'index';
    const expectedName = `${table.name}_${idx.columns.join('_')}_${suffix}`;
    const nameArg = idx.name === expectedName ? '' : `, ${quoteStr(idx.name)}`;

    if (idx.spatial) return `t.spatialIndex(${colsArg}${nameArg});`;
    if (idx.unique) return `t.unique(${colsArg}${nameArg});`;
    return `t.index(${colsArg}${nameArg});`;
}

function renderForeignKeyLine(fk: ForeignKeySchema, table: TableSchema): string {
    const colsArg = renderColumnsArg(fk.columns);
    const expectedName = `${table.name}_${fk.columns.join('_')}_foreign`;
    const nameArg = fk.name === expectedName ? '' : `, ${quoteStr(fk.name)}`;

    let line = `t.foreign(${colsArg}${nameArg})`;
    if (fk.referencedColumns.length === 1) {
        line += `.references(${quoteStr(fk.referencedColumns[0])})`;
    } else {
        line += `.referencesAll([${fk.referencedColumns.map(quoteStr).join(', ')}])`;
    }
    line += `.on(${quoteStr(fk.referencedTable)})`;
    if (fk.onDelete && fk.onDelete.toUpperCase() !== 'RESTRICT') line += `.onDelete(${quoteStr(fk.onDelete)})`;
    if (fk.onUpdate && fk.onUpdate.toUpperCase() !== 'RESTRICT') line += `.onUpdate(${quoteStr(fk.onUpdate)})`;
    return line + ';';
}

function renderColumnsArg(columns: string[]): string {
    if (columns.length === 1) return quoteStr(columns[0]);
    return `[${columns.map(quoteStr).join(', ')}]`;
}

function quoteStr(s: string): string {
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderJsValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return quoteStr(value);
    return JSON.stringify(value);
}
