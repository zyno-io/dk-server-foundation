import {
    ColumnModification,
    ColumnSchema,
    DatabaseSchema,
    Dialect,
    ForeignKeySchema,
    IndexSchema,
    SchemaDiff,
    TableDiff,
    TableSchema
} from './schema-model';
import { promptRename } from './prompt';

export async function compareSchemas(
    entitySchema: DatabaseSchema,
    dbSchema: DatabaseSchema,
    dialect: Dialect,
    interactive: boolean,
    pgSchema?: string
): Promise<SchemaDiff> {
    const addedTables: TableSchema[] = [];
    const removedTables: TableSchema[] = [];
    const modifiedTables: TableDiff[] = [];

    // Find added tables (in entities but not in DB)
    for (const [name, table] of entitySchema) {
        if (!dbSchema.has(name)) {
            addedTables.push(table);
        }
    }

    // Find removed tables (in DB but not in entities)
    for (const [name, table] of dbSchema) {
        if (!entitySchema.has(name)) {
            removedTables.push(table);
        }
    }

    // Compare matching tables
    for (const [name, entityTable] of entitySchema) {
        const dbTable = dbSchema.get(name);
        if (!dbTable) continue;

        const diff = await compareTable(entityTable, dbTable, dialect, interactive);
        if (diff) {
            modifiedTables.push(diff);
        }
    }

    // Collect all enum type names from entity tables (for safe PG DROP TYPE filtering)
    let entityEnumTypes: Set<string> | undefined;
    if (dialect === 'postgres') {
        entityEnumTypes = new Set<string>();
        for (const table of entitySchema.values()) {
            for (const col of table.columns) {
                if (col.type === 'enum' && col.enumTypeName) {
                    entityEnumTypes.add(col.enumTypeName);
                }
            }
        }
    }

    return { dialect, pgSchema, addedTables, removedTables, modifiedTables, entityEnumTypes };
}

async function compareTable(entityTable: TableSchema, dbTable: TableSchema, dialect: Dialect, interactive: boolean): Promise<TableDiff | null> {
    const diff: TableDiff = {
        tableName: entityTable.name,
        addedColumns: [],
        removedColumns: [],
        modifiedColumns: [],
        renamedColumns: [],
        reorderedColumns: [],
        addedIndexes: [],
        removedIndexes: [],
        addedForeignKeys: [],
        removedForeignKeys: [],
        primaryKeyChanged: false,
        addedEnumTypes: [],
        removedEnumTypes: [],
        modifiedEnumTypes: [],
        entityColumns: entityTable.columns
    };

    // --- Columns ---
    const entityColMap = new Map(entityTable.columns.map(c => [c.name, c]));
    const dbColMap = new Map(dbTable.columns.map(c => [c.name, c]));

    let candidateAdds = entityTable.columns.filter(c => !dbColMap.has(c.name));
    let candidateDrops = dbTable.columns.filter(c => !entityColMap.has(c.name) && !entityTable.skippedColumns?.has(c.name));

    // Rename detection
    if (candidateAdds.length > 0 && candidateDrops.length > 0) {
        if (interactive) {
            const renames = await detectRenames(entityTable.name, candidateAdds, candidateDrops);
            for (const rename of renames) {
                diff.renamedColumns.push(rename);
                candidateAdds = candidateAdds.filter(c => c.name !== rename.to);
                candidateDrops = candidateDrops.filter(c => c.name !== rename.from);
            }
        } else {
            console.warn(
                `Warning: Table \`${entityTable.name}\` has columns added (${candidateAdds.map(c => c.name).join(', ')}) ` +
                    `and removed (${candidateDrops.map(c => c.name).join(', ')}). ` +
                    `In non-interactive mode, these are treated as separate DROP/ADD operations (potential data loss). ` +
                    `Run without --non-interactive to detect renames.`
            );
        }
    }

    diff.addedColumns = candidateAdds;
    diff.removedColumns = candidateDrops;

    // Modified columns (present in both by same name)
    for (const [name, entityCol] of entityColMap) {
        const dbCol = dbColMap.get(name);
        if (!dbCol) continue;

        const mod = compareColumn(entityCol, dbCol);
        if (mod) diff.modifiedColumns.push(mod);
    }

    // Renamed columns may also have property changes (type, nullable, default, etc.)
    // For MySQL, CHANGE COLUMN already includes the full new definition so these are handled.
    // For PG, RENAME COLUMN only renames — separate ALTER COLUMN statements are needed.
    for (const rename of diff.renamedColumns) {
        const dbCol = dbColMap.get(rename.from);
        if (!dbCol) continue;

        const mod = compareColumn(rename.column, dbCol);
        if (mod) diff.modifiedColumns.push(mod);
    }

    // Column reordering (MySQL only)
    if (dialect === 'mysql') {
        diff.reorderedColumns = detectReorderingMySQL(entityTable, dbTable, diff);
    }

    // --- Primary Key ---
    const entityPK = entityTable.columns.filter(c => c.isPrimaryKey).map(c => c.name);
    const rawDbPK = dbTable.columns.filter(c => c.isPrimaryKey).map(c => c.name);
    // Apply rename mappings to DB PK names so that pure PK column renames
    // are not falsely detected as PK changes
    const renamedFromToMap = new Map(diff.renamedColumns.map(r => [r.from, r.to]));
    const dbPK = rawDbPK.map(name => renamedFromToMap.get(name) ?? name);
    if (!arraysEqual(entityPK, dbPK)) {
        diff.primaryKeyChanged = true;
        diff.newPrimaryKey = entityPK;
        // Store the raw DB column names (before rename mapping) so that DDL generation
        // can reference columns by their current DB names when stripping AUTO_INCREMENT
        // before DROP PRIMARY KEY (which happens before CHANGE COLUMN renames).
        diff.oldPrimaryKey = rawDbPK;
        diff.oldPrimaryKeyConstraintName = dbTable.primaryKeyConstraintName;
    }

    // --- Indexes ---
    const { added: addedIdx, removed: removedIdx } = compareIndexes(entityTable.indexes, dbTable.indexes);
    diff.addedIndexes = addedIdx;
    diff.removedIndexes = removedIdx;

    // --- Foreign Keys ---
    const { added: addedFK, removed: removedFK } = compareForeignKeys(entityTable.foreignKeys, dbTable.foreignKeys);
    diff.addedForeignKeys = addedFK;
    diff.removedForeignKeys = removedFK;

    // --- Enum types (PG only) ---
    if (dialect === 'postgres') {
        detectEnumChanges(diff, entityTable, dbTable);
    }

    // Check if there are any actual changes
    if (
        diff.addedColumns.length === 0 &&
        diff.removedColumns.length === 0 &&
        diff.modifiedColumns.length === 0 &&
        diff.renamedColumns.length === 0 &&
        diff.reorderedColumns.length === 0 &&
        diff.addedIndexes.length === 0 &&
        diff.removedIndexes.length === 0 &&
        diff.addedForeignKeys.length === 0 &&
        diff.removedForeignKeys.length === 0 &&
        !diff.primaryKeyChanged &&
        diff.addedEnumTypes.length === 0 &&
        diff.removedEnumTypes.length === 0 &&
        diff.modifiedEnumTypes.length === 0
    ) {
        return null;
    }

    return diff;
}

function compareColumn(entityCol: ColumnSchema, dbCol: ColumnSchema): ColumnModification | null {
    const typeChanged = !typesMatch(entityCol, dbCol);
    const nullableChanged = entityCol.nullable !== dbCol.nullable;
    const defaultChanged = !defaultsMatch(entityCol, dbCol);
    const autoIncrementChanged = entityCol.autoIncrement !== dbCol.autoIncrement;
    // ON UPDATE expression (MySQL only). If entity side has no onUpdateExpression, treat as "remove it".
    const onUpdateChanged = (entityCol.onUpdateExpression || '') !== (dbCol.onUpdateExpression || '');

    if (!typeChanged && !nullableChanged && !defaultChanged && !autoIncrementChanged && !onUpdateChanged) {
        return null;
    }

    return {
        name: entityCol.name,
        oldColumn: dbCol,
        newColumn: entityCol,
        typeChanged,
        nullableChanged,
        defaultChanged,
        autoIncrementChanged,
        onUpdateChanged
    };
}

function normalizeTypeAlias(type: string): string {
    switch (type) {
        case 'integer':
            return 'int';
        case 'numeric':
            return 'decimal';
        default:
            return type;
    }
}

function typesMatch(a: ColumnSchema, b: ColumnSchema): boolean {
    if (normalizeTypeAlias(a.type) !== normalizeTypeAlias(b.type)) return false;

    // Compare size when relevant
    if (a.size !== undefined || b.size !== undefined) {
        if (a.size !== b.size) return false;
    }

    // Compare scale
    if (a.scale !== undefined || b.scale !== undefined) {
        if (a.scale !== b.scale) return false;
    }

    // Compare unsigned
    if (a.unsigned !== b.unsigned) return false;

    // Compare enum type name (PG)
    if (a.enumTypeName || b.enumTypeName) {
        if (a.enumTypeName !== b.enumTypeName) return false;
    }

    // Compare enum values (sorted to ignore order-only differences)
    if (a.enumValues || b.enumValues) {
        const aVals = [...(a.enumValues || [])].sort();
        const bVals = [...(b.enumValues || [])].sort();
        if (!arraysEqual(aVals, bVals)) return false;
    }

    return true;
}

function normalizeDefaultExpression(expr: string): string {
    let s = expr.toUpperCase().trim();
    // Normalize now() and CURRENT_TIMESTAMP() variants to CURRENT_TIMESTAMP (no parens)
    s = s.replace(/\bNOW\s*\(\)/g, 'CURRENT_TIMESTAMP');
    s = s.replace(/\bCURRENT_TIMESTAMP\s*\(\)/g, 'CURRENT_TIMESTAMP');
    return s;
}

function defaultsMatch(a: ColumnSchema, b: ColumnSchema): boolean {
    // Skip default comparison for auto-increment columns
    if (a.autoIncrement || b.autoIncrement) return true;

    // If entity side has no default info at all, treat as "unspecified" and skip comparison.
    // Columns without field initializers have no default info and are skipped to avoid spurious diffs.
    if (a.defaultValue === undefined && a.defaultExpression === undefined) return true;

    // Both have expression defaults
    if (a.defaultExpression && b.defaultExpression) {
        return normalizeDefaultExpression(a.defaultExpression) === normalizeDefaultExpression(b.defaultExpression);
    }

    // One has expression, other doesn't
    if (a.defaultExpression !== b.defaultExpression) {
        if ((a.defaultExpression && !b.defaultExpression) || (!a.defaultExpression && b.defaultExpression)) {
            return false;
        }
    }

    // Compare values
    if (a.defaultValue === undefined && b.defaultValue === undefined) return true;
    if (a.defaultValue === undefined || b.defaultValue === undefined) return false;

    return String(a.defaultValue) === String(b.defaultValue);
}

async function detectRenames(
    tableName: string,
    candidateAdds: ColumnSchema[],
    candidateDrops: ColumnSchema[]
): Promise<{ from: string; to: string; column: ColumnSchema }[]> {
    const renames: { from: string; to: string; column: ColumnSchema }[] = [];
    let remainingDrops = [...candidateDrops];

    for (const added of candidateAdds) {
        // Prefer exact type matches
        let compatibleDrops = remainingDrops.filter(d => typesMatch(added, d));

        // Fall back to all remaining drops (type differs — prompt will warn)
        if (compatibleDrops.length === 0 && remainingDrops.length > 0) {
            compatibleDrops = remainingDrops;
        }

        if (compatibleDrops.length === 0) continue;

        const result = await promptRename(
            tableName,
            added.name,
            compatibleDrops.map(d => d.name)
        );
        if (result) {
            renames.push({ from: result, to: added.name, column: added });
            remainingDrops = remainingDrops.filter(d => d.name !== result);
        }
    }

    return renames;
}

function detectReorderingMySQL(entityTable: TableSchema, dbTable: TableSchema, diff: TableDiff): { name: string; after: string | null }[] {
    // Build the expected column order from the entity
    const entityOrder = entityTable.columns.map(c => c.name);

    // Build the current DB order, accounting for adds/drops/renames
    const renamedFrom = new Map(diff.renamedColumns.map(r => [r.from, r.to]));
    const removedNames = new Set(diff.removedColumns.map(c => c.name));
    const addedNames = new Set(diff.addedColumns.map(c => c.name));

    // Current DB order with renames applied and removals excluded
    const dbOrder = dbTable.columns.map(c => renamedFrom.get(c.name) || c.name).filter(name => !removedNames.has(name));

    // Entity order without new additions (the columns that should be in DB order)
    const existingEntityOrder = entityOrder.filter(name => !addedNames.has(name));

    // Check if the existing columns are in the same relative order
    if (arraysEqual(existingEntityOrder, dbOrder)) {
        return [];
    }

    // Compute which columns need MODIFY with AFTER
    const reorders: { name: string; after: string | null }[] = [];
    for (let i = 0; i < existingEntityOrder.length; i++) {
        if (existingEntityOrder[i] !== dbOrder[i]) {
            const after = i === 0 ? null : existingEntityOrder[i - 1];
            reorders.push({ name: existingEntityOrder[i], after });
        }
    }

    return reorders;
}

function compareIndexes(entityIndexes: IndexSchema[], dbIndexes: IndexSchema[]): { added: IndexSchema[]; removed: IndexSchema[] } {
    // Match by column set + uniqueness + spatial, not by name
    const indexKey = (idx: IndexSchema) => `${idx.columns.join(',')}:${idx.unique}:${idx.spatial}`;

    const entityKeys = new Map(entityIndexes.map(i => [indexKey(i), i]));
    const dbKeys = new Map(dbIndexes.map(i => [indexKey(i), i]));

    const added = entityIndexes.filter(i => !dbKeys.has(indexKey(i)));
    const removed = dbIndexes.filter(i => !entityKeys.has(indexKey(i)));

    return { added, removed };
}

function normalizeFkAction(action: string): string {
    const upper = action.toUpperCase();
    // NO ACTION and RESTRICT are semantically equivalent for comparison
    return upper === 'NO ACTION' ? 'RESTRICT' : upper;
}

function compareForeignKeys(entityFKs: ForeignKeySchema[], dbFKs: ForeignKeySchema[]): { added: ForeignKeySchema[]; removed: ForeignKeySchema[] } {
    // Match by structure including actions, not by name
    // NO ACTION and RESTRICT are treated as equivalent to avoid diff churn
    const fkKey = (fk: ForeignKeySchema) =>
        `${fk.columns.join(',')}→${fk.referencedTable}(${fk.referencedColumns.join(',')})/${normalizeFkAction(fk.onDelete)}/${normalizeFkAction(fk.onUpdate)}`;

    const entityKeys = new Map(entityFKs.map(fk => [fkKey(fk), fk]));
    const dbKeys = new Map(dbFKs.map(fk => [fkKey(fk), fk]));

    const added = entityFKs.filter(fk => !dbKeys.has(fkKey(fk)));
    const removed = dbFKs.filter(fk => !entityKeys.has(fkKey(fk)));

    return { added, removed };
}

function detectEnumChanges(diff: TableDiff, entityTable: TableSchema, dbTable: TableSchema): void {
    const dbColMap = new Map(dbTable.columns.map(c => [c.name, c]));

    for (const col of entityTable.columns) {
        if (col.type !== 'enum' || !col.enumValues || !col.enumTypeName) continue;

        const dbCol = dbColMap.get(col.name);

        // New enum type for new columns
        if (!dbCol) {
            diff.addedEnumTypes.push({
                typeName: col.enumTypeName,
                values: col.enumValues
            });
            continue;
        }

        // Existing column: non-enum → enum requires CREATE TYPE
        if (dbCol.type !== 'enum') {
            diff.addedEnumTypes.push({
                typeName: col.enumTypeName,
                values: col.enumValues
            });
            continue;
        }

        // Enum type name changed — need to create the new type and drop the old one
        if (dbCol.enumTypeName && dbCol.enumTypeName !== col.enumTypeName) {
            diff.addedEnumTypes.push({
                typeName: col.enumTypeName,
                values: col.enumValues
            });
            diff.removedEnumTypes.push(dbCol.enumTypeName);
            // The type change will be picked up by compareColumn() → typesMatch() → enumTypeName comparison
            continue;
        }

        // Existing column with enum value changes (same type name)
        if (dbCol.enumValues) {
            const added = col.enumValues.filter(v => !dbCol.enumValues!.includes(v));
            const removed = dbCol.enumValues.filter(v => !col.enumValues!.includes(v));
            if (added.length > 0 || removed.length > 0) {
                diff.modifiedEnumTypes.push({
                    typeName: col.enumTypeName,
                    added,
                    removed,
                    newValues: col.enumValues,
                    tableName: diff.tableName,
                    columnName: col.name
                });
            }
        }
    }

    // Detect orphaned enum types from removed columns or enum→non-enum changes
    const entityColMap = new Map(entityTable.columns.map(c => [c.name, c]));
    for (const dbCol of dbTable.columns) {
        if (dbCol.type !== 'enum' || !dbCol.enumTypeName) continue;

        const entityCol = entityColMap.get(dbCol.name);
        // Column removed entirely — its enum type may be orphaned
        // Column changed from enum to non-enum — old type may be orphaned
        if (!entityCol || entityCol.type !== 'enum' || entityCol.enumTypeName !== dbCol.enumTypeName) {
            // Only schedule drop if not already handled above (type-name change already pushes to removedEnumTypes)
            if (!diff.removedEnumTypes.includes(dbCol.enumTypeName)) {
                diff.removedEnumTypes.push(dbCol.enumTypeName);
            }
        }
    }
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}
