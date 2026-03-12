import { cli } from '@deepkit/app';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

import { getAppConfig } from '../../app/resolver';
import { DBProvider } from '../../app/state';
import { createLogger } from '../../services';
import { getDialect } from '../dialect';
import { generateDDL } from './create/ddl-generator';
import { readEntitiesSchema } from './create/entity-reader';
import { buildFileContent } from './create/file-generator';
import { SchemaDiff } from './create/schema-model';
import { getSourceMigrationsDir } from './helpers';

@cli.controller('migration:reset')
export class MigrationResetCommand {
    private logger = createLogger('MigrationReset');
    private migrationsDir = getSourceMigrationsDir();

    constructor(private dbProvider: DBProvider) {}

    async execute() {
        // Step 1: Ensure migrations directory exists
        if (!existsSync(this.migrationsDir)) {
            this.logger.info(`Creating migrations directory: ${this.migrationsDir}`);
            mkdirSync(this.migrationsDir, { recursive: true });
        }

        // Step 2: Remove all .ts files from migrations directory
        const files = readdirSync(this.migrationsDir).filter(f => f.endsWith('.ts'));
        this.logger.info(`Removing ${files.length} migration file(s)`);
        for (const file of files) {
            const filePath = path.join(this.migrationsDir, file);
            unlinkSync(filePath);
            this.logger.info(`Removed ${file}`);
        }

        // Step 3: Read entity schema from code definitions
        const db = this.dbProvider.db;
        const dialect = getDialect(db.adapter as SQLDatabaseAdapter);
        const pgSchema = dialect === 'postgres' ? (getAppConfig().PG_SCHEMA ?? 'public') : 'public';

        this.logger.info('Reading entity definitions...');
        const entitySchema = readEntitiesSchema(db, dialect);
        const tables = Array.from(entitySchema.values());
        this.logger.info(`Found ${tables.length} entity table(s)`);

        // Step 4: Generate DDL by treating all entity tables as "added"
        const diff: SchemaDiff = {
            dialect,
            pgSchema: dialect === 'postgres' ? pgSchema : undefined,
            addedTables: tables,
            removedTables: [],
            modifiedTables: []
        };
        const statements = generateDDL(diff);

        if (statements.length === 0) {
            this.logger.info('No tables found to generate base migration.');
            return;
        }

        // Step 6: Write migration file
        const migrationContent = buildFileContent(statements);
        const migrationPath = path.join(this.migrationsDir, '00000000_000000_base.ts');

        writeFileSync(migrationPath, migrationContent, 'utf8');
        this.logger.info(`Created initial migration: ${migrationPath}`);
        this.logger.info(`Migration reset complete with ${tables.length} table(s)`);
    }
}
