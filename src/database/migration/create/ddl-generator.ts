import { quoteId } from '../../dialect';
import { ColumnModification, ColumnSchema, Dialect, ForeignKeySchema, IndexSchema, SchemaDiff, TableDiff, TableSchema } from './schema-model';

const VALID_FK_ACTIONS = new Set(['RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'NO ACTION']);

export function generateDDL(diff: SchemaDiff): string[] {
    const statements: string[] = [];
    const { dialect, pgSchema } = diff;

    // Global enum type dedup set (PG only)
    const globalEnumTypes = new Set<string>();

    // Collect new-table FKs to emit after all tables are created (handles cross-table dependencies)
    const deferredFKs: { tableName: string; fk: ForeignKeySchema }[] = [];

    // New tables
    for (const table of diff.addedTables) {
        if (dialect === 'postgres') {
            // Create enum types first for PG, deduplicating globally
            for (const col of table.columns) {
                if (col.type === 'enum' && col.enumTypeName && col.enumValues) {
                    if (!globalEnumTypes.has(col.enumTypeName)) {
                        globalEnumTypes.add(col.enumTypeName);
                        statements.push(createEnumType(col.enumTypeName, col.enumValues, pgSchema));
                    }
                }
            }
        }
        statements.push(createTable(table, dialect, pgSchema));
        // Create indexes for new tables
        for (const idx of table.indexes) {
            statements.push(createIndex(table.name, idx, dialect, pgSchema));
        }
        // Defer FK creation until after all tables exist
        for (const fk of table.foreignKeys) {
            deferredFKs.push({ tableName: table.name, fk });
        }
    }

    // Enum type modifications (PG only) — deduplicated across all tables
    // Phase 1: RENAME + CREATE for recreations, ADD VALUE for additions (before table DDL)
    // Phase 2: table DDL handles ALTER COLUMN TYPE casts for modified columns
    // Phase 3: DROP old types after table DDL
    const deferredEnumDrops: string[] = [];
    if (dialect === 'postgres') {
        const seenEnumMods = new Map<string, { typeName: string; added: string[]; removed: string[]; newValues: string[] }>();
        for (const tableDiff of diff.modifiedTables) {
            for (const enumMod of tableDiff.modifiedEnumTypes) {
                if (!seenEnumMods.has(enumMod.typeName)) {
                    seenEnumMods.set(enumMod.typeName, {
                        typeName: enumMod.typeName,
                        added: enumMod.added,
                        removed: enumMod.removed,
                        newValues: enumMod.newValues
                    });
                }
            }
        }
        for (const [, enumMod] of seenEnumMods) {
            if (enumMod.removed.length > 0) {
                // Recreation: RENAME old + CREATE new before table DDL; DROP old after.
                // Drop any pre-existing _old type first to avoid collision.
                const oldName = `${enumMod.typeName}_old`;
                const vals = enumMod.newValues.map(v => `'${escapeStr(v)}'`).join(', ');
                const typeRef = qType(enumMod.typeName, pgSchema);
                const oldTypeRef = qType(oldName, pgSchema);
                statements.push(`DROP TYPE IF EXISTS ${oldTypeRef}`);
                statements.push(`ALTER TYPE ${typeRef} RENAME TO ${q('postgres', oldName)}`);
                statements.push(`CREATE TYPE ${typeRef} AS ENUM (${vals})`);
                // Per-table DDL handles ALTER COLUMN TYPE with USING cast (via modifiedColumns)
                deferredEnumDrops.push(`DROP TYPE IF EXISTS ${oldTypeRef}`);
            } else {
                for (const val of enumMod.added) {
                    statements.push(`ALTER TYPE ${qType(enumMod.typeName, pgSchema)} ADD VALUE '${escapeStr(val)}'`);
                }
            }
        }
    }

    // Modified tables
    for (const tableDiff of diff.modifiedTables) {
        statements.push(...generateTableDDL(tableDiff, dialect, pgSchema, globalEnumTypes));
    }

    // Emit deferred FKs for new tables (after all tables and modifications are done)
    for (const { tableName, fk } of deferredFKs) {
        statements.push(addForeignKey(tableName, fk, dialect, pgSchema));
    }

    // Removed tables — drop FKs first to handle dependencies, then drop tables
    if (diff.removedTables.length > 0) {
        for (const table of diff.removedTables) {
            for (const fk of table.foreignKeys) {
                if (dialect === 'mysql') {
                    statements.push(`ALTER TABLE ${qTable(dialect, table.name, pgSchema)} DROP FOREIGN KEY ${q(dialect, fk.name)}`);
                } else {
                    statements.push(`ALTER TABLE ${qTable(dialect, table.name, pgSchema)} DROP CONSTRAINT ${q(dialect, fk.name)}`);
                }
            }
        }
        for (const table of diff.removedTables) {
            statements.push(`DROP TABLE ${qTable(dialect, table.name, pgSchema)}`);
        }
    }

    // Drop orphaned enum types (from type-name changes, removed columns, or enum→non-enum changes)
    if (dialect === 'postgres') {
        const seenDrops = new Set(deferredEnumDrops.map(s => s)); // already-scheduled drops
        for (const tableDiff of diff.modifiedTables) {
            for (const typeName of tableDiff.removedEnumTypes) {
                const dropStmt = `DROP TYPE IF EXISTS ${qType(typeName, pgSchema)}`;
                if (!seenDrops.has(dropStmt)) {
                    seenDrops.add(dropStmt);
                    deferredEnumDrops.push(dropStmt);
                }
            }
        }
        // Also drop enum types from removed tables
        for (const table of diff.removedTables) {
            for (const col of table.columns) {
                if (col.type === 'enum' && col.enumTypeName) {
                    const dropStmt = `DROP TYPE IF EXISTS ${qType(col.enumTypeName, pgSchema)}`;
                    if (!seenDrops.has(dropStmt)) {
                        seenDrops.add(dropStmt);
                        deferredEnumDrops.push(dropStmt);
                    }
                }
            }
        }

        // Filter out enum types that are still in use by any entity table
        const enumTypesInUse = diff.entityEnumTypes ?? new Set<string>();
        // Filter: only drop types not still in use
        const filteredDrops = deferredEnumDrops.filter(stmt => {
            for (const typeName of enumTypesInUse) {
                const dropStmt = `DROP TYPE IF EXISTS ${qType(typeName, pgSchema)}`;
                if (stmt === dropStmt) return false;
            }
            return true;
        });
        statements.push(...filteredDrops);
    }

    return statements;
}

function generateTableDDL(diff: TableDiff, dialect: Dialect, pgSchema?: string, globalEnumTypes?: Set<string>): string[] {
    if (dialect === 'mysql') {
        return generateMySQLTableDDL(diff);
    }
    return generatePostgresTableDDL(diff, pgSchema, globalEnumTypes);
}

// --- MySQL DDL ---

function generateMySQLTableDDL(diff: TableDiff): string[] {
    const stmts: string[] = [];
    const t = q('mysql', diff.tableName);

    // 1. Drop FKs
    for (const fk of diff.removedForeignKeys) {
        stmts.push(`ALTER TABLE ${t} DROP FOREIGN KEY ${q('mysql', fk.name)}`);
    }

    // 2. Drop indexes
    for (const idx of diff.removedIndexes) {
        stmts.push(`ALTER TABLE ${t} DROP INDEX ${q('mysql', idx.name)}`);
    }

    // 3. Drop PK if changed (only if there was an existing PK to drop)
    // Track columns that had AUTO_INCREMENT temporarily stripped so we can restore it after ADD PK
    const autoIncStrippedForPKDrop: ColumnSchema[] = [];
    if (diff.primaryKeyChanged && diff.oldPrimaryKey && diff.oldPrimaryKey.length > 0) {
        // MySQL requires AUTO_INCREMENT columns to be part of a KEY. Before dropping the PK,
        // we must strip AUTO_INCREMENT from ALL old PK columns that currently have it.
        // This covers: columns being modified, columns being removed, and columns whose PK
        // membership changes even though autoIncrement itself doesn't change.
        //
        // oldPrimaryKey contains the raw DB column names (before renames).
        // We need to MODIFY using the current DB names since renames haven't happened yet.
        const oldPKSet = new Set(diff.oldPrimaryKey);
        const alreadyHandled = new Set<string>();
        // Map old DB name → new entity name for renamed columns
        const renameOldToNew = new Map(diff.renamedColumns.map(r => [r.from, r.to]));

        // Check modified columns (mod.name is the entity/new name; mod.oldColumn has the DB name)
        for (const mod of diff.modifiedColumns) {
            const dbName = mod.oldColumn.name;
            if (oldPKSet.has(dbName) && mod.oldColumn.autoIncrement) {
                const tempCol = { ...mod.oldColumn, autoIncrement: false };
                stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(tempCol)}`);
                alreadyHandled.add(dbName);
            }
        }
        // Check removed columns (already using DB names)
        for (const col of diff.removedColumns) {
            if (oldPKSet.has(col.name) && col.autoIncrement) {
                const tempCol = { ...col, autoIncrement: false };
                stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(tempCol)}`);
                alreadyHandled.add(col.name);
            }
        }
        // Check remaining old PK columns (e.g., PK shape change where column stays auto-increment)
        if (diff.entityColumns) {
            for (const dbColName of oldPKSet) {
                if (alreadyHandled.has(dbColName)) continue;
                // The entity column may have been renamed; find it by the new name if applicable
                const entityName = renameOldToNew.get(dbColName) ?? dbColName;
                const entityCol = diff.entityColumns.find(c => c.name === entityName);
                if (entityCol && entityCol.autoIncrement) {
                    // Emit MODIFY using the current DB name (rename hasn't happened yet)
                    const tempCol = { ...entityCol, name: dbColName, autoIncrement: false };
                    stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(tempCol)}`);
                    autoIncStrippedForPKDrop.push(entityCol);
                }
            }
        }
        stmts.push(`ALTER TABLE ${t} DROP PRIMARY KEY`);
    }

    // 4. Column drops
    for (const col of diff.removedColumns) {
        stmts.push(`ALTER TABLE ${t} DROP COLUMN ${q('mysql', col.name)}`);
    }

    // 5. Column renames (CHANGE COLUMN includes full definition + AFTER)
    // Exclude added columns from AFTER clause — they don't exist yet at this step
    // If PK is being changed and the renamed column has AUTO_INCREMENT, strip it now and
    // defer the full definition to after ADD PK (MySQL requires AI columns to be keyed).
    const addedNames = new Set(diff.addedColumns.map(c => c.name));
    const deferredAutoIncrementRenames: { from: string; column: ColumnSchema; after: string }[] = [];
    for (const rename of diff.renamedColumns) {
        const after = findAfterClause(rename.column, diff, 'mysql', addedNames);
        if (rename.column.autoIncrement && diff.primaryKeyChanged) {
            const tempCol = { ...rename.column, autoIncrement: false };
            stmts.push(`ALTER TABLE ${t} CHANGE COLUMN ${q('mysql', rename.from)} ${mysqlColumnDef(tempCol)}${after}`);
            deferredAutoIncrementRenames.push({ from: rename.column.name, column: rename.column, after });
        } else {
            stmts.push(`ALTER TABLE ${t} CHANGE COLUMN ${q('mysql', rename.from)} ${mysqlColumnDef(rename.column)}${after}`);
        }
    }

    // 6. Column modifications (skip renamed columns — CHANGE COLUMN in step 5 handles them)
    // Defer modifications where the new column has AUTO_INCREMENT AND the PK is being changed,
    // since MySQL requires AUTO_INCREMENT columns to already be part of a KEY. This covers both:
    // (a) autoIncrementChanged (adding AI) and (b) AI unchanged but PK being dropped and re-added.
    const renamedNames = new Set(diff.renamedColumns.map(r => r.to));
    const deferredAutoIncrementMods: ColumnModification[] = [];
    for (const mod of diff.modifiedColumns) {
        if (renamedNames.has(mod.name)) continue;
        if (mod.newColumn.autoIncrement && (mod.autoIncrementChanged || diff.primaryKeyChanged)) {
            deferredAutoIncrementMods.push(mod);
            continue;
        }
        const after = findAfterClauseForExisting(mod.name, diff, 'mysql');
        stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(mod.newColumn)}${after}`);
    }

    // 7. Column adds
    // For added columns with AUTO_INCREMENT, add without AUTO_INCREMENT first,
    // then apply AUTO_INCREMENT after ADD PRIMARY KEY (MySQL requires the column to be keyed first)
    const deferredAutoIncrementAdds: ColumnSchema[] = [];
    for (const col of diff.addedColumns) {
        const after = findAfterClause(col, diff, 'mysql');
        if (col.autoIncrement) {
            const tempCol = { ...col, autoIncrement: false };
            stmts.push(`ALTER TABLE ${t} ADD COLUMN ${mysqlColumnDef(tempCol)}${after}`);
            deferredAutoIncrementAdds.push(col);
        } else {
            stmts.push(`ALTER TABLE ${t} ADD COLUMN ${mysqlColumnDef(col)}${after}`);
        }
    }

    // 8. Column reorders (only those not already handled by rename/modify/add)
    const handled = new Set([...diff.renamedColumns.map(r => r.to), ...diff.modifiedColumns.map(m => m.name), ...diff.addedColumns.map(c => c.name)]);
    for (const reorder of diff.reorderedColumns) {
        if (handled.has(reorder.name)) continue;
        const col = diff.entityColumns?.find(c => c.name === reorder.name);
        if (!col) continue;
        const after = reorder.after === null ? ' FIRST' : ` AFTER ${q('mysql', reorder.after)}`;
        stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(col)}${after}`);
    }

    // 9. Add PK
    if (diff.primaryKeyChanged && diff.newPrimaryKey && diff.newPrimaryKey.length > 0) {
        const pkCols = diff.newPrimaryKey.map(c => q('mysql', c)).join(', ');
        stmts.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${pkCols})`);
    }

    // 9b. Apply deferred AUTO_INCREMENT additions (requires column to be part of a KEY)
    for (const mod of deferredAutoIncrementMods) {
        const after = findAfterClauseForExisting(mod.name, diff, 'mysql');
        stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(mod.newColumn)}${after}`);
    }
    for (const col of deferredAutoIncrementAdds) {
        stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(col)}`);
    }
    // Re-apply AUTO_INCREMENT for renamed columns that had it stripped before PK drop
    for (const deferred of deferredAutoIncrementRenames) {
        stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(deferred.column)}`);
    }
    // Restore AUTO_INCREMENT for columns that were temporarily stripped for PK drop
    for (const col of autoIncStrippedForPKDrop) {
        stmts.push(`ALTER TABLE ${t} MODIFY COLUMN ${mysqlColumnDef(col)}`);
    }

    // 10. Add indexes
    for (const idx of diff.addedIndexes) {
        stmts.push(createIndex(diff.tableName, idx, 'mysql'));
    }

    // 11. Add FKs
    for (const fk of diff.addedForeignKeys) {
        stmts.push(addForeignKey(diff.tableName, fk, 'mysql'));
    }

    return stmts;
}

// --- PostgreSQL DDL ---

function generatePostgresTableDDL(diff: TableDiff, pgSchema?: string, globalEnumTypes?: Set<string>): string[] {
    const stmts: string[] = [];
    const t = qTable('postgres', diff.tableName, pgSchema);

    // 1. Create new enum types (deduplicated globally)
    for (const enumType of diff.addedEnumTypes) {
        if (globalEnumTypes && globalEnumTypes.has(enumType.typeName)) continue;
        globalEnumTypes?.add(enumType.typeName);
        stmts.push(createEnumType(enumType.typeName, enumType.values, pgSchema));
    }

    // 2. Enum modifications are handled globally in generateDDL() to deduplicate across tables

    // 3. Drop FKs
    for (const fk of diff.removedForeignKeys) {
        stmts.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q('postgres', fk.name)}`);
    }

    // 4. Drop indexes (schema-qualified for non-public schemas)
    for (const idx of diff.removedIndexes) {
        stmts.push(`DROP INDEX ${qTable('postgres', idx.name, pgSchema)}`);
    }

    // 5. Drop PK if changed (only if there was an existing PK to drop)
    if (diff.primaryKeyChanged && diff.oldPrimaryKey && diff.oldPrimaryKey.length > 0) {
        const constraintName = diff.oldPrimaryKeyConstraintName ?? `${diff.tableName}_pkey`;
        stmts.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q('postgres', constraintName)}`);
    }

    // 6. Column drops
    for (const col of diff.removedColumns) {
        stmts.push(`ALTER TABLE ${t} DROP COLUMN ${q('postgres', col.name)}`);
    }

    // 7. Column renames
    for (const rename of diff.renamedColumns) {
        stmts.push(`ALTER TABLE ${t} RENAME COLUMN ${q('postgres', rename.from)} TO ${q('postgres', rename.to)}`);
    }

    // 8. Column type changes
    // For enum type changes, drop default before TYPE change and restore after,
    // since the default may be typed as the old enum and block the cast.
    const enumDefaultsToRestore: { colName: string; defaultExpr: string }[] = [];
    for (const mod of diff.modifiedColumns) {
        if (mod.typeChanged) {
            const typeDef = pgTypeDef(mod.newColumn, pgSchema);
            if (mod.newColumn.type === 'enum' && mod.newColumn.enumTypeName) {
                // Drop existing default if the old column had one (it may reference the old enum type)
                if (mod.oldColumn.defaultExpression || mod.oldColumn.defaultValue !== undefined) {
                    stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} DROP DEFAULT`);
                    // Queue restore: use new column's default if available, else old column's
                    const restoreExpr = mod.newColumn.defaultExpression ?? mod.oldColumn.defaultExpression;
                    const restoreVal = mod.newColumn.defaultValue !== undefined ? mod.newColumn.defaultValue : mod.oldColumn.defaultValue;
                    if (restoreExpr) {
                        enumDefaultsToRestore.push({ colName: mod.name, defaultExpr: restoreExpr });
                    } else if (restoreVal !== undefined) {
                        enumDefaultsToRestore.push({
                            colName: mod.name,
                            defaultExpr: `'${escapeStr(String(restoreVal))}'`
                        });
                    }
                }
                // Enum type changes need USING cast
                stmts.push(
                    `ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} TYPE ${typeDef} USING ${q('postgres', mod.name)}::text::${typeDef}`
                );
            } else {
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} TYPE ${typeDef}`);
            }
        }
    }
    // Restore defaults that were dropped for enum type changes
    for (const restore of enumDefaultsToRestore) {
        stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', restore.colName)} SET DEFAULT ${restore.defaultExpr}`);
    }

    // 9. Column nullable changes
    for (const mod of diff.modifiedColumns) {
        if (mod.nullableChanged) {
            if (mod.newColumn.nullable) {
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} DROP NOT NULL`);
            } else {
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} SET NOT NULL`);
            }
        }
    }

    // 10. Column default changes
    for (const mod of diff.modifiedColumns) {
        if (mod.defaultChanged) {
            if (mod.newColumn.defaultExpression) {
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} SET DEFAULT ${mod.newColumn.defaultExpression}`);
            } else if (mod.newColumn.defaultValue !== undefined) {
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} SET DEFAULT '${escapeStr(String(mod.newColumn.defaultValue))}'`);
            } else {
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} DROP DEFAULT`);
            }
        }
    }

    // 11. Auto-increment changes (sequence management)
    for (const mod of diff.modifiedColumns) {
        if (mod.autoIncrementChanged) {
            const seqName = `${diff.tableName}_${mod.name}_seq`;
            if (mod.newColumn.autoIncrement) {
                // Adding auto-increment: create sequence, set default, sync to existing data
                const seqRef = qTable('postgres', seqName, pgSchema);
                stmts.push(`CREATE SEQUENCE ${seqRef} OWNED BY ${t}.${q('postgres', mod.name)}`);
                const nextvalArg = escapeStr(pgRegclass(seqName, pgSchema));
                stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} SET DEFAULT nextval('${nextvalArg}')`);
                stmts.push(
                    `SELECT setval('${nextvalArg}', COALESCE((SELECT MAX(${q('postgres', mod.name)}) FROM ${t}), 1), ` +
                        `(SELECT MAX(${q('postgres', mod.name)}) FROM ${t}) IS NOT NULL)`
                );
            } else {
                // Removing auto-increment
                if (mod.oldColumn.isIdentity) {
                    // Identity columns use DROP IDENTITY
                    stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} DROP IDENTITY`);
                } else {
                    // Sequence-backed columns: drop default and sequence
                    stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${q('postgres', mod.name)} DROP DEFAULT`);
                    // Use actual sequence name from DB if available, otherwise fall back to conventional name
                    const actualSeqName = mod.oldColumn.sequenceName;
                    if (actualSeqName) {
                        stmts.push(`DROP SEQUENCE IF EXISTS ${actualSeqName}`);
                    } else {
                        stmts.push(`DROP SEQUENCE IF EXISTS ${qTable('postgres', seqName, pgSchema)}`);
                    }
                }
            }
        }
    }

    // 12. Column adds
    for (const col of diff.addedColumns) {
        stmts.push(`ALTER TABLE ${t} ADD COLUMN ${pgColumnDef(col, pgSchema)}`);
    }

    // 13. Add PK
    if (diff.primaryKeyChanged && diff.newPrimaryKey && diff.newPrimaryKey.length > 0) {
        const pkCols = diff.newPrimaryKey.map(c => q('postgres', c)).join(', ');
        stmts.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${pkCols})`);
    }

    // 14. Add indexes
    for (const idx of diff.addedIndexes) {
        stmts.push(createIndex(diff.tableName, idx, 'postgres', pgSchema));
    }

    // 15. Add FKs
    for (const fk of diff.addedForeignKeys) {
        stmts.push(addForeignKey(diff.tableName, fk, 'postgres', pgSchema));
    }

    return stmts;
}

// --- Shared helpers ---

function createTable(table: TableSchema, dialect: Dialect, pgSchema?: string): string {
    const lines: string[] = [];
    const pkCols = table.columns.filter(c => c.isPrimaryKey).map(c => c.name);

    for (const col of table.columns) {
        if (dialect === 'mysql') {
            lines.push(`    ${mysqlColumnDef(col)}`);
        } else {
            lines.push(`    ${pgColumnDef(col, pgSchema)}`);
        }
    }

    if (pkCols.length > 0) {
        const quoted = pkCols.map(c => q(dialect, c)).join(', ');
        lines.push(`    PRIMARY KEY (${quoted})`);
    }

    return `CREATE TABLE ${qTable(dialect, table.name, pgSchema)} (\n${lines.join(',\n')}\n)`;
}

function createIndex(tableName: string, idx: IndexSchema, dialect: Dialect, pgSchema?: string): string {
    const unique = idx.unique ? 'UNIQUE ' : '';
    const spatial = idx.spatial && dialect === 'mysql' ? 'SPATIAL ' : '';
    const cols = idx.columns.map(c => q(dialect, c)).join(', ');
    return `CREATE ${spatial}${unique}INDEX ${q(dialect, idx.name)} ON ${qTable(dialect, tableName, pgSchema)} (${cols})`;
}

function addForeignKey(tableName: string, fk: ForeignKeySchema, dialect: Dialect, pgSchema?: string): string {
    const cols = fk.columns.map(c => q(dialect, c)).join(', ');
    const refCols = fk.referencedColumns.map(c => q(dialect, c)).join(', ');
    const onDelete = validateFkAction(fk.onDelete, dialect);
    const onUpdate = validateFkAction(fk.onUpdate, dialect);
    return (
        `ALTER TABLE ${qTable(dialect, tableName, pgSchema)} ADD CONSTRAINT ${q(dialect, fk.name)} ` +
        `FOREIGN KEY (${cols}) REFERENCES ${qTable(dialect, fk.referencedTable, pgSchema)} (${refCols}) ` +
        `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
    );
}

function validateFkAction(action: string, dialect: Dialect): string {
    const upper = action.toUpperCase();
    if (!VALID_FK_ACTIONS.has(upper)) {
        throw new Error(`Invalid foreign key action: '${action}'`);
    }
    if (upper === 'SET DEFAULT' && dialect === 'mysql') {
        throw new Error(`Foreign key action 'SET DEFAULT' is not supported by MySQL/InnoDB`);
    }
    return upper;
}

function createEnumType(typeName: string, values: string[], pgSchema?: string): string {
    const qualifiedName = qType(typeName, pgSchema);
    const vals = values.map(v => `'${escapeStr(v)}'`).join(', ');
    const schemaFilter =
        pgSchema && pgSchema !== 'public' ? ` AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${escapeStr(pgSchema)}')` : '';
    return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${escapeStr(typeName)}'${schemaFilter}) THEN CREATE TYPE ${qualifiedName} AS ENUM (${vals}); END IF; END $$`;
}

// --- MySQL column definition ---

function mysqlColumnDef(col: ColumnSchema): string {
    let def = `${q('mysql', col.name)} ${mysqlTypeDef(col)}`;

    if (col.unsigned) def += ' UNSIGNED';
    if (!col.nullable) def += ' NOT NULL';
    if (col.autoIncrement) def += ' AUTO_INCREMENT';

    if (col.defaultExpression) {
        def += ` DEFAULT ${col.defaultExpression}`;
    } else if (col.defaultValue !== undefined) {
        def += ` DEFAULT '${escapeStr(String(col.defaultValue), 'mysql')}'`;
    }

    if (col.onUpdateExpression) {
        def += ` ON UPDATE ${col.onUpdateExpression}`;
    }

    return def;
}

function mysqlTypeDef(col: ColumnSchema): string {
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

// --- PostgreSQL column definition ---

function pgColumnDef(col: ColumnSchema, pgSchema?: string): string {
    let typeDef: string;
    if (col.autoIncrement) {
        // Use SERIAL/BIGSERIAL for auto-increment
        typeDef = col.type === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
    } else {
        typeDef = pgTypeDef(col, pgSchema);
    }

    let def = `${q('postgres', col.name)} ${typeDef}`;

    if (!col.nullable && !col.autoIncrement) def += ' NOT NULL';

    if (!col.autoIncrement) {
        if (col.defaultExpression) {
            def += ` DEFAULT ${col.defaultExpression}`;
        } else if (col.defaultValue !== undefined) {
            def += ` DEFAULT '${escapeStr(String(col.defaultValue))}'`;
        }
    }

    return def;
}

function pgTypeDef(col: ColumnSchema, pgSchema?: string): string {
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
            return col.enumTypeName ? qType(col.enumTypeName, pgSchema) : 'TEXT';
        default:
            return col.type.toUpperCase();
    }
}

// --- AFTER clause helpers (MySQL) ---

function findAfterClause(col: ColumnSchema, diff: TableDiff, dialect: Dialect, excludeNames?: Set<string>): string {
    if (dialect !== 'mysql') return '';

    // Look up the preceding column from the entity column list, skipping any excluded names
    // (e.g., not-yet-added columns when computing AFTER for a rename step)
    if (diff.entityColumns) {
        const idx = diff.entityColumns.findIndex(c => c.name === col.name);
        if (idx >= 0) {
            // Walk backwards to find the nearest preceding column that is not excluded
            for (let i = idx - 1; i >= 0; i--) {
                const prev = diff.entityColumns[i];
                if (!excludeNames || !excludeNames.has(prev.name)) {
                    return ` AFTER ${q('mysql', prev.name)}`;
                }
            }
            return ' FIRST';
        }
    }

    // Fallback for ordinalPosition
    if (col.ordinalPosition === 1) return ' FIRST';

    return '';
}

function findAfterClauseForExisting(colName: string, diff: TableDiff, dialect: Dialect): string {
    if (dialect !== 'mysql') return '';

    // Check if this column needs reordering
    const reorder = diff.reorderedColumns.find(r => r.name === colName);
    if (reorder) {
        return reorder.after === null ? ' FIRST' : ` AFTER ${q('mysql', reorder.after)}`;
    }

    return '';
}

function q(dialect: Dialect, name: string): string {
    return quoteId(dialect, name);
}

function qTable(dialect: Dialect, name: string, pgSchema?: string): string {
    if (dialect === 'postgres' && pgSchema && pgSchema !== 'public') {
        return `${quoteId(dialect, pgSchema)}.${quoteId(dialect, name)}`;
    }
    return quoteId(dialect, name);
}

function qType(typeName: string, pgSchema?: string): string {
    if (pgSchema && pgSchema !== 'public') {
        return `${quoteId('postgres', pgSchema)}.${quoteId('postgres', typeName)}`;
    }
    return quoteId('postgres', typeName);
}

function pgRegclass(name: string, pgSchema?: string): string {
    // Build a regclass-compatible identifier string with proper quoting for use inside SQL string literals
    if (pgSchema && pgSchema !== 'public') {
        return `${quoteId('postgres', pgSchema)}.${quoteId('postgres', name)}`;
    }
    return quoteId('postgres', name);
}

function escapeStr(s: string, dialect?: Dialect): string {
    // MySQL also treats backslashes as escape characters in string literals
    if (dialect === 'mysql') {
        s = s.replace(/\\/g, '\\\\');
    }
    return s.replace(/'/g, "''");
}
