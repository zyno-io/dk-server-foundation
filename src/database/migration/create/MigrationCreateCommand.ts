import { cli, Flag } from '@deepkit/app';
import { SQLDatabaseAdapter } from '@deepkit/sql';

import { getAppConfig } from '../../../app/resolver';
import { DBProvider } from '../../../app/state';
import { createLogger, pinoLogger } from '../../../services';
import { getDialect } from '../../dialect';
import { compareSchemas } from './comparator';
import { readAllTableNames, readDatabaseSchema } from './db-reader';
import { generateDDL } from './ddl-generator';
import { readEntitiesSchema } from './entity-reader';
import { generateMigrationFile } from './file-generator';
import { promptMigrationDescription, setNonInteractive } from './prompt';
import { INTERNAL_TABLES } from './schema-model';

@cli.controller('migration:create')
export class MigrationCreateCommand {
    private logger = createLogger('MigrationCreate');

    constructor(private dbProvider: DBProvider) {}

    async execute(nonInteractive: boolean & Flag<{ description: 'Skip interactive prompts' }> = false) {
        if (nonInteractive) {
            setNonInteractive(true);
        }

        try {
            const db = this.dbProvider.db;
            const dialect = getDialect(db.adapter as SQLDatabaseAdapter);
            const pgSchema = dialect === 'postgres' ? (getAppConfig().PG_SCHEMA ?? 'public') : 'public';

            this.logger.info(`Dialect: ${dialect}`);

            // Step 1: Read entity schema
            this.logger.info('Reading entity definitions...');
            const entitySchema = readEntitiesSchema(db, dialect);
            const entityTableNames = Array.from(entitySchema.keys());
            this.logger.info(`Found ${entityTableNames.length} entity table(s): ${entityTableNames.join(', ')}`);

            // Step 2: Discover all DB tables and union with entity table names
            const allDbTableNames = await readAllTableNames(db, dialect, pgSchema);
            const dbOnlyTables = allDbTableNames.filter(n => !entitySchema.has(n) && !INTERNAL_TABLES.has(n));
            const tableNames = [...entityTableNames, ...dbOnlyTables];

            // Step 3: Read database schema
            this.logger.info('Reading database schema...');
            const dbSchema = await readDatabaseSchema(db, dialect, tableNames, pgSchema);

            // Step 4: Compare schemas
            this.logger.info('Comparing schemas...');
            const diff = await compareSchemas(entitySchema, dbSchema, dialect, !nonInteractive, pgSchema);

            // Step 5: Generate DDL
            const statements = generateDDL(diff);

            if (statements.length === 0) {
                this.logger.info('No schema changes detected.');
                return;
            }

            // Step 6: Show summary
            this.logger.info(`\nChanges detected:`);
            if (diff.addedTables.length > 0) {
                this.logger.info(`  Added tables: ${diff.addedTables.map(t => t.name).join(', ')}`);
            }
            if (diff.removedTables.length > 0) {
                this.logger.info(`  Removed tables: ${diff.removedTables.map(t => t.name).join(', ')}`);
            }
            for (const table of diff.modifiedTables) {
                const changes: string[] = [];
                if (table.addedColumns.length > 0) changes.push(`+${table.addedColumns.length} cols`);
                if (table.removedColumns.length > 0) changes.push(`-${table.removedColumns.length} cols`);
                if (table.modifiedColumns.length > 0) changes.push(`~${table.modifiedColumns.length} cols`);
                if (table.renamedColumns.length > 0) changes.push(`${table.renamedColumns.length} renamed`);
                if (table.addedIndexes.length > 0) changes.push(`+${table.addedIndexes.length} idx`);
                if (table.removedIndexes.length > 0) changes.push(`-${table.removedIndexes.length} idx`);
                if (table.primaryKeyChanged) changes.push('PK changed');
                this.logger.info(`  ${table.tableName}: ${changes.join(', ')}`);
            }

            this.logger.info(`\nDDL statements (${statements.length}):`);
            for (const stmt of statements) {
                this.logger.info(`  ${stmt}`);
            }

            // Step 7: Prompt for description and generate file
            pinoLogger.flush();
            await new Promise(resolve => setTimeout(resolve, 100));
            const description = await promptMigrationDescription();
            const filePath = generateMigrationFile(statements, description);
            this.logger.info(`\nMigration file created: ${filePath}`);
        } finally {
            setNonInteractive(false);
        }
    }
}
