import { cli } from '@deepkit/app';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

import { DBProvider } from '../../app/state';
import { createLogger } from '../../services';
import { getDialect } from '../dialect';
import { generateBuilderMigrationFile } from './create/builder-regenerator';
import { readEntitiesSchema } from './create/entity-reader';
import { getSourceMigrationsDir } from './helpers';

@cli.controller('migration:reset')
export class MigrationResetCommand {
    private logger = createLogger('MigrationReset');
    private migrationsDir = getSourceMigrationsDir();

    constructor(private dbProvider: DBProvider) {}

    async execute() {
        if (!existsSync(this.migrationsDir)) {
            this.logger.info(`Creating migrations directory: ${this.migrationsDir}`);
            mkdirSync(this.migrationsDir, { recursive: true });
        }

        const files = readdirSync(this.migrationsDir).filter(f => f.endsWith('.ts'));
        this.logger.info(`Removing ${files.length} migration file(s)`);
        for (const file of files) {
            const filePath = path.join(this.migrationsDir, file);
            unlinkSync(filePath);
            this.logger.info(`Removed ${file}`);
        }

        const db = this.dbProvider.db;
        const dialect = getDialect(db.adapter as SQLDatabaseAdapter);

        // Reset reads entities in the active dialect's canonical form. The generated migration uses
        // dialect-portable builder calls, but cross-dialect parity isn't perfect — see docs.
        this.logger.info(`Reading entity definitions (dialect: ${dialect})...`);
        const entitySchema = readEntitiesSchema(db, dialect);
        const tables = Array.from(entitySchema.values());
        this.logger.info(`Found ${tables.length} entity table(s)`);

        if (tables.length === 0) {
            this.logger.info('No tables found to generate base migration.');
            return;
        }

        const migrationContent = generateBuilderMigrationFile(tables);
        const migrationPath = path.join(this.migrationsDir, '00000000_000000_base.ts');

        writeFileSync(migrationPath, migrationContent, 'utf8');
        this.logger.info(`Created initial migration: ${migrationPath}`);
        this.logger.info(`Migration reset complete with ${tables.length} table(s)`);
    }
}
