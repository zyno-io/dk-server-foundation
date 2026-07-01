import { Dialect } from '../dialect';

const MAX_IDENTIFIER_LENGTH: Record<Dialect, number> = {
    mysql: 64,
    postgres: 63
};

export function maxIdentifierLength(dialect: Dialect): number {
    return MAX_IDENTIFIER_LENGTH[dialect];
}

export function normalizeGeneratedIdentifier(name: string, dialect: Dialect): string {
    const maxLength = maxIdentifierLength(dialect);
    if (name.length <= maxLength) return name;

    const hash = hashIdentifier(name);
    const remaining = maxLength - hash.length - 2;
    const headLength = Math.ceil(remaining / 2);
    const tailLength = Math.floor(remaining / 2);

    return `${name.slice(0, headLength)}_${hash}_${name.slice(name.length - tailLength)}`;
}

export function defaultBlueprintIdentifierName(tableName: string, columns: string[], suffix: string, dialect: Dialect): string {
    return normalizeGeneratedIdentifier(`${tableName}_${columns.join('_')}_${suffix}`, dialect);
}

export function defaultEntityIndexName(tableName: string, columns: string[], dialect: Dialect): string {
    return normalizeGeneratedIdentifier(`idx_${tableName}_${columns.join('_')}`, dialect);
}

export function defaultEntityForeignKeyName(tableName: string, columns: string[], dialect: Dialect): string {
    return normalizeGeneratedIdentifier(`fk_${tableName}_${columns.join('_')}`, dialect);
}

function hashIdentifier(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
