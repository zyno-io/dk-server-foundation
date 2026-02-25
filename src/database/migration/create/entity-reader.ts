import {
    ReflectionClass,
    ReflectionKind,
    ReflectionProperty,
    Type,
    TypeClass,
    TypeEnum,
    TypeIntersection,
    TypeLiteral,
    typeAnnotation,
    databaseAnnotation,
    validationAnnotation,
    isUUIDType
} from '@deepkit/type';

import { BaseDatabase } from '../../common';
import { ColumnSchema, DatabaseSchema, Dialect, IndexSchema, ForeignKeySchema, INTERNAL_TABLES, TableSchema } from './schema-model';

export function readEntitiesSchema(db: BaseDatabase, dialect: Dialect): DatabaseSchema {
    const schema: DatabaseSchema = new Map();
    const entities = db.entityRegistry.all();

    for (const entity of entities) {
        const reflection = ReflectionClass.from(entity);
        const tableName = reflection.getCollectionName() || reflection.name || '';
        if (!tableName) continue;

        if (INTERNAL_TABLES.has(tableName)) continue;

        const table = readTableSchema(reflection, tableName, dialect, db);
        schema.set(tableName, table);
    }

    return schema;
}

function readTableSchema(reflection: ReflectionClass<unknown>, tableName: string, dialect: Dialect, db: BaseDatabase): TableSchema {
    const columns: ColumnSchema[] = [];
    const indexes: IndexSchema[] = [];
    const foreignKeys: ForeignKeySchema[] = [];
    const pkColumns: string[] = [];
    const skippedColumns = new Set<string>();

    const properties = reflection.getProperties();
    let ordinal = 0;

    for (const prop of properties) {
        if (prop.isBackReference()) continue;

        // For references, we handle the FK column, not the object
        if (prop.isReference()) {
            const col = readReferenceColumn(prop, ++ordinal, dialect, db, tableName);
            if (col) {
                columns.push(col);
                if (col.isPrimaryKey) pkColumns.push(col.name);

                // Create FK
                const fk = readForeignKey(prop, tableName, dialect, db);
                if (fk) foreignKeys.push(fk);
            } else {
                skippedColumns.add(prop.name);
            }
            continue;
        }

        const col = readColumn(prop, ++ordinal, dialect, tableName);
        if (col) {
            columns.push(col);
            if (col.isPrimaryKey) pkColumns.push(col.name);

            // Single-column index from property
            const indexInfo = prop.getIndex();
            if (indexInfo) {
                indexes.push({
                    name: indexInfo.name || `idx_${tableName}_${col.name}`,
                    columns: [col.name],
                    unique: indexInfo.unique || false,
                    spatial: false
                });
            }
        } else {
            skippedColumns.add(prop.name);
            console.warn(`migration:create: Skipping column '${prop.name}' in '${tableName}' — unsupported type`);
        }
    }

    // Multi-column indexes from entity-level indexes
    if (reflection.indexes) {
        for (const idx of reflection.indexes) {
            indexes.push({
                name: idx.options.name || `idx_${tableName}_${idx.names.join('_')}`,
                columns: idx.names,
                unique: idx.options.unique || false,
                spatial: dialect === 'mysql' ? idx.options.spatial || false : false
            });
        }
    }

    // Deduplicate indexes by name (Deepkit stores property-level indexes
    // both on the property and in reflection.indexes)
    const seen = new Set<string>();
    const dedupedIndexes = indexes.filter(idx => {
        if (seen.has(idx.name)) return false;
        seen.add(idx.name);
        return true;
    });

    return { name: tableName, columns, indexes: dedupedIndexes, foreignKeys, skippedColumns };
}

function readColumn(prop: ReflectionProperty, ordinal: number, dialect: Dialect, tableName?: string): ColumnSchema | null {
    const type = prop.type;
    const resolved = resolveColumnType(type, prop.name, dialect, tableName);
    if (!resolved) return null;

    const col: ColumnSchema = {
        name: prop.name,
        type: resolved.type,
        size: resolved.size,
        scale: resolved.scale,
        unsigned: resolved.unsigned || false,
        nullable: prop.isOptional() || prop.isNullable(),
        autoIncrement: prop.isAutoIncrement(),
        isPrimaryKey: prop.isPrimaryKey(),
        defaultValue: resolved.defaultValue,
        defaultExpression: resolved.defaultExpression,
        enumValues: resolved.enumValues,
        enumTypeName: resolved.enumTypeName,
        ordinalPosition: ordinal
    };

    // ON UPDATE expression (MySQL only)
    if (dialect === 'mysql') {
        const onUpdateAnnotation = typeAnnotation.getType(type, 'dksf:onUpdate');
        if (onUpdateAnnotation?.kind === ReflectionKind.literal && typeof onUpdateAnnotation.literal === 'string') {
            col.onUpdateExpression = (onUpdateAnnotation.literal as string).toUpperCase();
        }
    }

    return col;
}

function readReferenceColumn(
    prop: ReflectionProperty,
    ordinal: number,
    dialect: Dialect,
    _db: BaseDatabase,
    tableName?: string
): ColumnSchema | null {
    // A reference property stores the PK of the referenced entity
    const refClass = prop.getResolvedReflectionClass();

    // Guard: only single-column PKs are supported for references
    const refPkProps = refClass.getProperties().filter(p => p.isPrimaryKey());
    if (refPkProps.length !== 1) {
        console.warn(
            `migration:create: Skipping reference '${prop.name}' in '${tableName ?? '?'}' — ` +
                `referenced entity '${refClass.name}' has ${refPkProps.length === 0 ? 'no' : 'composite'} primary key (unsupported)`
        );
        return null;
    }

    const refPk = refClass.getPrimary();
    if (!refPk) return null;

    // Resolve the PK column type of the referenced entity
    const resolved = resolveColumnType(refPk.type, prop.name, dialect, tableName);
    if (!resolved) return null;

    return {
        name: prop.name,
        type: resolved.type,
        size: resolved.size,
        scale: resolved.scale,
        unsigned: resolved.unsigned || false,
        nullable: prop.isOptional() || prop.isNullable(),
        autoIncrement: false,
        isPrimaryKey: prop.isPrimaryKey(),
        ordinalPosition: ordinal
    };
}

function readForeignKey(prop: ReflectionProperty, tableName: string, _dialect: Dialect, _db: BaseDatabase): ForeignKeySchema | null {
    const refClass = prop.getResolvedReflectionClass();
    const refTableName = refClass.getCollectionName() || refClass.name || '';

    // Guard: only single-column PKs are supported for FK generation
    const refPkProps = refClass.getProperties().filter(p => p.isPrimaryKey());
    if (refPkProps.length !== 1) {
        // Warning already emitted by readReferenceColumn
        return null;
    }

    const refPk = refClass.getPrimary();
    if (!refPk || !refTableName) return null;

    const ref = prop.getReference();
    const onDelete: string = ref?.onDelete ?? 'CASCADE';
    // Deepkit's ReferenceOptions does not expose onUpdate; future-proof with dynamic check.
    // Default is CASCADE to match Deepkit's internal FK default (see @deepkit/sql ForeignKey class).
    const onUpdate: string = (ref as Record<string, unknown>)?.onUpdate ? String((ref as Record<string, unknown>).onUpdate) : 'CASCADE';

    return {
        name: `fk_${tableName}_${prop.name}`,
        columns: [prop.name],
        referencedTable: refTableName,
        referencedColumns: [refPk.name],
        onDelete: onDelete.toUpperCase(),
        onUpdate: onUpdate.toUpperCase()
    };
}

interface ResolvedType {
    type: string;
    size?: number;
    scale?: number;
    unsigned?: boolean;
    defaultValue?: unknown;
    defaultExpression?: string;
    enumValues?: string[];
    enumTypeName?: string;
}

function resolveColumnType(type: Type, columnName: string, dialect: Dialect, parentTableName?: string): ResolvedType | null {
    // Unwrap unions: filter out undefined/null (they only affect nullable)
    if (type.kind === ReflectionKind.union) {
        const nonNull = type.types.filter(
            t => t.kind !== ReflectionKind.undefined && t.kind !== ReflectionKind.null && !(t.kind === ReflectionKind.literal && t.literal === null)
        );
        if (nonNull.length === 1) {
            return resolveColumnType(nonNull[0], columnName, dialect, parentTableName);
        }
        // Multiple non-null union members -- treat as the first (lossy; warn)
        if (nonNull.length > 0) {
            console.warn(
                `migration:create: Column '${columnName}'${parentTableName ? ` in '${parentTableName}'` : ''} ` +
                    `has a union type with ${nonNull.length} non-null members — using the first member only`
            );
            return resolveColumnType(nonNull[0], columnName, dialect, parentTableName);
        }
        return null;
    }

    // Unwrap intersections: look for base type + annotations
    if (type.kind === ReflectionKind.intersection) {
        return resolveIntersectionType(type, columnName, dialect, parentTableName);
    }

    // Check dksf:type annotation
    const dksfType = typeAnnotation.getType(type, 'dksf:type');
    if (dksfType?.kind === ReflectionKind.literal) {
        const result = resolveDksfType(dksfType.literal as string, type, dialect);
        if (result) return result;
    }

    // Deepkit's built-in UUID type (string & TypeAnnotation<'UUIDv4'>)
    if (isUUIDType(type)) {
        return dialect === 'mysql' ? { type: 'binary', size: 16 } : { type: 'uuid' };
    }

    // Check dialect-specific database annotation
    const dbAnnotation = databaseAnnotation.getDatabase<{ type?: string }>(type, dialect);
    if (dbAnnotation?.type) {
        return { type: dbAnnotation.type.toLowerCase() };
    }

    // Check generic database annotation
    const genericDbAnnotation = databaseAnnotation.getDatabase<{ type?: string }>(type, '*');
    if (genericDbAnnotation?.type) {
        return { type: genericDbAnnotation.type.toLowerCase() };
    }

    // Check dksf:length annotation
    const lengthAnnotation = typeAnnotation.getType(type, 'dksf:length');
    if (lengthAnnotation?.kind === ReflectionKind.literal && typeof lengthAnnotation.literal === 'number') {
        return { type: 'char', size: lengthAnnotation.literal };
    }

    // Check validation annotations for MaxLength
    const maxLength = getMaxLength(type);
    if (maxLength !== undefined) {
        return { type: 'varchar', size: maxLength };
    }

    // Enum types
    if (type.kind === ReflectionKind.enum) {
        return resolveEnumType(type, columnName, dialect, parentTableName);
    }

    // Primitive type map
    return resolvePrimitiveType(type, dialect);
}

function resolveIntersectionType(type: TypeIntersection, columnName: string, dialect: Dialect, parentTableName?: string): ResolvedType | null {
    // Priority 1: Check for dialect-specific database annotation on the intersection
    const dbAnnotation = databaseAnnotation.getDatabase<{ type?: string }>(type, dialect);
    if (dbAnnotation?.type) {
        return { type: dbAnnotation.type.toLowerCase() };
    }

    // Priority 2: Check for generic database annotation
    const genericDbAnnotation = databaseAnnotation.getDatabase<{ type?: string }>(type, '*');
    if (genericDbAnnotation?.type) {
        return { type: genericDbAnnotation.type.toLowerCase() };
    }

    // Priority 3: dksf:type annotation
    const dksfType = typeAnnotation.getType(type, 'dksf:type');
    if (dksfType?.kind === ReflectionKind.literal) {
        const result = resolveDksfType(dksfType.literal as string, type, dialect);
        if (result) return result;
    }

    // Priority 4: Deepkit's built-in UUID type (string & TypeAnnotation<'UUIDv4'>)
    if (isUUIDType(type)) {
        return dialect === 'mysql' ? { type: 'binary', size: 16 } : { type: 'uuid' };
    }

    // Priority 5: dksf:length annotation
    const lengthAnnotation = typeAnnotation.getType(type, 'dksf:length');
    if (lengthAnnotation?.kind === ReflectionKind.literal && typeof lengthAnnotation.literal === 'number') {
        return { type: 'char', size: lengthAnnotation.literal };
    }

    // Priority 6: MaxLength validation
    const maxLength = getMaxLength(type);
    if (maxLength !== undefined) {
        return { type: 'varchar', size: maxLength };
    }

    // Priority 7: Find the base type in the intersection members
    for (const member of type.types) {
        // Skip annotation-only types (PrimaryKey, AutoIncrement, Index, etc.)
        if (
            member.kind === ReflectionKind.class ||
            member.kind === ReflectionKind.string ||
            member.kind === ReflectionKind.number ||
            member.kind === ReflectionKind.boolean ||
            member.kind === ReflectionKind.bigint ||
            member.kind === ReflectionKind.enum
        ) {
            const result = resolveColumnType(member, columnName, dialect, parentTableName);
            if (result) return result;
        }
    }

    return null;
}

function resolveDksfType(dksfType: string, _type: Type, _dialect: Dialect): ResolvedType | null {
    switch (dksfType) {
        case 'uuid':
            return { type: 'char', size: 36 };
        case 'date':
            return { type: 'date' };
        case 'phone':
        case 'phoneNanp':
            return { type: 'varchar', size: 20 };
        default:
            return null;
    }
}

function resolveEnumType(type: TypeEnum, columnName: string, dialect: Dialect, parentTableName?: string): ResolvedType | null {
    const values = type.values.filter(v => v != null);

    if (values.length === 0) return null;

    // String enum
    if (typeof values[0] === 'string') {
        const stringValues = values.filter((v): v is string => typeof v === 'string');
        if (dialect === 'postgres') {
            const typeName = parentTableName ? `${parentTableName}_${columnName}` : columnName;
            return {
                type: 'enum',
                enumValues: stringValues,
                enumTypeName: typeName
            };
        }
        return {
            type: 'enum',
            enumValues: stringValues
        };
    }

    // Numeric enum
    const numValues = values.filter((v): v is number => typeof v === 'number');
    const minVal = Math.min(...numValues);
    const maxVal = Math.max(...numValues);
    if (dialect === 'mysql') {
        if (minVal >= 0 && maxVal <= 255) return { type: 'tinyint', unsigned: true };
        if (minVal >= -128 && maxVal <= 127) return { type: 'tinyint' };
        if (minVal >= 0 && maxVal <= 65535) return { type: 'smallint', unsigned: true };
        return { type: 'int' };
    }
    if (minVal >= -32768 && maxVal <= 32767) return { type: 'smallint' };
    return { type: 'int' };
}

function getMaxLength(type: Type): number | undefined {
    // Check for Deepkit's MaxLength validation annotation
    try {
        const annotations = validationAnnotation.getAnnotations(type);
        if (annotations) {
            for (const annotation of annotations) {
                if (annotation.name === 'maxLength') {
                    const arg = annotation.args?.[0];
                    if (arg && arg.kind === ReflectionKind.literal && typeof arg.literal === 'number') {
                        return arg.literal;
                    }
                }
            }
        }
    } catch {
        // validationAnnotation might not be available
    }
    return undefined;
}

function resolvePrimitiveType(type: Type, dialect: Dialect): ResolvedType | null {
    switch (type.kind) {
        case ReflectionKind.string:
            return { type: 'varchar', size: 255 };

        case ReflectionKind.number:
            return dialect === 'mysql' ? { type: 'double' } : { type: 'double precision' };

        case ReflectionKind.boolean:
            return dialect === 'mysql' ? { type: 'tinyint', size: 1 } : { type: 'boolean' };

        case ReflectionKind.bigint:
            return { type: 'bigint' };

        case ReflectionKind.class:
            return resolveClassType(type, dialect);

        case ReflectionKind.objectLiteral:
        case ReflectionKind.array:
            return dialect === 'mysql' ? { type: 'json' } : { type: 'jsonb' };

        case ReflectionKind.any:
            return dialect === 'mysql' ? { type: 'json' } : { type: 'jsonb' };

        case ReflectionKind.literal: {
            // literal string → varchar, literal number → int, etc.
            const literal = (type as TypeLiteral).literal;
            if (typeof literal === 'string') return { type: 'varchar', size: 255 };
            if (typeof literal === 'number') return { type: 'int' };
            if (typeof literal === 'boolean') {
                return dialect === 'mysql' ? { type: 'tinyint', size: 1 } : { type: 'boolean' };
            }
            return null;
        }

        default:
            return null;
    }
}

function resolveClassType(type: TypeClass, dialect: Dialect): ResolvedType | null {
    const className = type.classType?.name;

    switch (className) {
        case 'Date':
            return dialect === 'mysql' ? { type: 'datetime' } : { type: 'timestamp' };

        case 'Coordinate':
            if (dialect === 'mysql') {
                return { type: 'point' };
            }
            // PG doesn't support POINT in this framework
            return null;

        case 'ArrayBuffer':
        case 'Uint8Array':
            return dialect === 'mysql' ? { type: 'blob' } : { type: 'bytea' };

        default:
            // Unknown class → JSON
            return dialect === 'mysql' ? { type: 'json' } : { type: 'jsonb' };
    }
}
