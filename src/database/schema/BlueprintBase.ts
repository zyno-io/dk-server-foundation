import { ColumnSchema, ForeignKeySchema, IndexSchema } from '../migration/create/schema-model';
import { ColumnDefinition, ForeignKeyBuilder } from './ColumnDefinition';
import { Grammar } from './grammar/Grammar';

/**
 * Shared base for `Blueprint` (create-table) and `AlterBlueprint` (alter-table).
 *
 * Provides every column-type method (`string`, `boolean`, etc.) plus index/FK helpers.
 * Subclasses decide where to store added columns/indexes/FKs via the abstract impl hooks.
 */
export abstract class BlueprintBase {
    constructor(
        public readonly tableName: string,
        public readonly grammar: Grammar
    ) {}

    // --- Subclass hooks ---

    protected abstract addColumnImpl(col: ColumnSchema): ColumnDefinition;
    protected abstract addIndexImpl(idx: IndexSchema): void;
    protected abstract addForeignKeyImpl(fk: ForeignKeySchema): void;

    // --- Column types ---

    /** BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY (mysql) / BIGSERIAL PRIMARY KEY (pg). */
    id(name: string = 'id'): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'bigint',
            unsigned: true,
            nullable: false,
            autoIncrement: true,
            isPrimaryKey: true,
            ordinalPosition: 0
        });
    }

    string(name: string, length: number = 255): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'varchar',
            size: length,
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    char(name: string, length: number = 1): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'char',
            size: length,
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    text(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'text',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    tinyint(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'tinyint',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    smallint(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'smallint',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    integer(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'int',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    bigInteger(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'bigint',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    boolean(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'boolean',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    float(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'float',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    double(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'double',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    decimal(name: string, precision?: number, scale?: number): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'decimal',
            size: precision,
            scale,
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    date(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'date',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    /** MySQL: DATETIME. PG: TIMESTAMP (no tz). Use timestamptz() for tz-aware. */
    dateTime(name: string): ColumnDefinition {
        const type = this.grammar.dialect === 'mysql' ? 'datetime' : 'timestamp';
        return this.addColumnImpl({ name, type, unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: false, ordinalPosition: 0 });
    }

    timestamp(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'timestamp',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    timestamptz(name: string): ColumnDefinition {
        const type = this.grammar.dialect === 'mysql' ? 'timestamp' : 'timestamptz';
        return this.addColumnImpl({ name, type, unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: false, ordinalPosition: 0 });
    }

    binary(name: string, length: number = 16): ColumnDefinition {
        const type = this.grammar.dialect === 'mysql' ? 'binary' : 'bytea';
        return this.addColumnImpl({
            name,
            type,
            size: length,
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    blob(name: string): ColumnDefinition {
        const type = this.grammar.dialect === 'mysql' ? 'blob' : 'bytea';
        return this.addColumnImpl({ name, type, unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: false, ordinalPosition: 0 });
    }

    json(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'json',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    /** PG: JSONB. MySQL: JSON (no jsonb equivalent). */
    jsonb(name: string): ColumnDefinition {
        const type = this.grammar.dialect === 'mysql' ? 'json' : 'jsonb';
        return this.addColumnImpl({ name, type, unsigned: false, nullable: false, autoIncrement: false, isPrimaryKey: false, ordinalPosition: 0 });
    }

    /** Canonical (binary) UUID storage. PG: UUID. MySQL: BINARY(16). */
    uuid(name: string): ColumnDefinition {
        if (this.grammar.dialect === 'mysql') {
            return this.addColumnImpl({
                name,
                type: 'binary',
                size: 16,
                unsigned: false,
                nullable: false,
                autoIncrement: false,
                isPrimaryKey: false,
                ordinalPosition: 0
            });
        }
        return this.addColumnImpl({
            name,
            type: 'uuid',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    /** String-form UUID storage. Both dialects: CHAR(36). */
    uuidString(name: string): ColumnDefinition {
        return this.addColumnImpl({
            name,
            type: 'char',
            size: 36,
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    /** Enum. On PG, generates a CREATE TYPE; pass `typeName` to share across tables. */
    enum(name: string, values: string[], typeName?: string): ColumnDefinition {
        const enumTypeName = typeName ?? `${this.tableName}_${name}_enum`;
        return this.addColumnImpl({
            name,
            type: 'enum',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            enumValues: values,
            enumTypeName,
            ordinalPosition: 0
        });
    }

    /** MySQL only — throws on PostgreSQL. */
    point(name: string): ColumnDefinition {
        if (this.grammar.dialect !== 'mysql') {
            throw new Error(`BlueprintBase.point() is MySQL-only; use raw SQL or a different geometry type on ${this.grammar.dialect}.`);
        }
        return this.addColumnImpl({
            name,
            type: 'point',
            unsigned: false,
            nullable: false,
            autoIncrement: false,
            isPrimaryKey: false,
            ordinalPosition: 0
        });
    }

    // --- Convenience ---

    /** Adds createdAt + updatedAt with DEFAULT CURRENT_TIMESTAMP (and ON UPDATE CURRENT_TIMESTAMP for updatedAt on MySQL). */
    timestamps(): void {
        this.dateTime('createdAt').notNull().defaultRaw('CURRENT_TIMESTAMP');
        const updatedAt = this.dateTime('updatedAt').notNull().defaultRaw('CURRENT_TIMESTAMP');
        if (this.grammar.dialect === 'mysql') {
            updatedAt.onUpdate('CURRENT_TIMESTAMP');
        }
    }

    // --- Indexes ---

    index(columns: string | string[], name?: string): this {
        const cols = Array.isArray(columns) ? columns : [columns];
        this.addIndexImpl({
            name: name ?? this.defaultIndexName(cols, 'index'),
            columns: cols,
            unique: false,
            spatial: false
        });
        return this;
    }

    unique(columns: string | string[], name?: string): this {
        const cols = Array.isArray(columns) ? columns : [columns];
        this.addIndexImpl({
            name: name ?? this.defaultIndexName(cols, 'unique'),
            columns: cols,
            unique: true,
            spatial: false
        });
        return this;
    }

    /** MySQL only — silently no-op on PG. */
    spatialIndex(columns: string | string[], name?: string): this {
        const cols = Array.isArray(columns) ? columns : [columns];
        this.addIndexImpl({
            name: name ?? this.defaultIndexName(cols, 'spatial'),
            columns: cols,
            unique: false,
            spatial: true
        });
        return this;
    }

    // --- Foreign keys ---

    foreign(columns: string | string[], constraintName?: string): ForeignKeyBuilder {
        const cols = Array.isArray(columns) ? columns : [columns];
        const fk: ForeignKeySchema = {
            name: constraintName ?? this.defaultIndexName(cols, 'foreign'),
            columns: cols,
            referencedTable: '',
            referencedColumns: [],
            onDelete: 'RESTRICT',
            onUpdate: 'RESTRICT'
        };
        this.addForeignKeyImpl(fk);
        return new ForeignKeyBuilder(fk);
    }

    /** Composite primary key. Subclass-specific behavior. */
    abstract primary(columns: string[]): this;

    protected defaultIndexName(columns: string[], suffix: string): string {
        return `${this.tableName}_${columns.join('_')}_${suffix}`;
    }
}
