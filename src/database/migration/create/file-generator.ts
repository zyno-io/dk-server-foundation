import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

import { getSourceMigrationsDir } from '../helpers';
import { COMMENT_PREFIX } from './ddl-generator';

export function generateMigrationFile(statements: string[], description: string): string {
    const migrationsDir = getSourceMigrationsDir();

    if (!existsSync(migrationsDir)) {
        mkdirSync(migrationsDir, { recursive: true });
    }

    const timestamp = formatTimestamp(new Date());
    const slug = slugify(description);
    const filename = `${timestamp}_${slug}.ts`;
    const filePath = path.join(migrationsDir, filename);

    const content = buildFileContent(statements);
    writeFileSync(filePath, content, 'utf8');

    return filePath;
}

export function buildFileContent(statements: string[]): string {
    const lines: string[] = [];
    let hasGroup = false;

    for (const stmt of statements) {
        if (stmt.startsWith(COMMENT_PREFIX)) {
            const tableName = stmt.slice(COMMENT_PREFIX.length);
            if (hasGroup) lines.push('');
            lines.push(`    // Table: ${tableName}`);
            hasGroup = true;
        } else {
            lines.push(formatStatement(stmt));
        }
    }

    const execLines = lines.join('\n');
    return `import { createMigration } from '@zyno-io/dk-server-foundation';\n\nexport default createMigration(async db => {\n${execLines}\n});\n`;
}

function formatStatement(stmt: string): string {
    const escaped = stmt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    if (!escaped.includes('\n')) {
        return `    await db.rawExecute(\`${escaped}\`);`;
    }
    const indented = escaped
        .split('\n')
        .map(line => `        ${line}`)
        .join('\n');
    return `    await db.rawExecute(\`\n${indented}\n    \`);`;
}

function formatTimestamp(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${d}_${h}${min}${s}`;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 50);
}
