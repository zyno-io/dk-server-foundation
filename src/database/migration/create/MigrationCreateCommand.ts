import { cli, Flag } from '@deepkit/app';
import { SQLDatabaseAdapter } from '@deepkit/sql';

import { getAppConfig } from '../../../app/resolver';
import { DBProvider } from '../../../app/state';
import { createLogger, pinoLogger } from '../../../services';
import { getDialect } from '../../dialect';
import { generateBuilderMigrationFromDiff } from './builder-regenerator';
import { compareSchemas } from './comparator';
import { readAllTableNames, readDatabaseSchema } from './db-reader';
import { generateDDL } from './ddl-generator';
import { readEntitiesSchema } from './entity-reader';
import { generateMigrationFile, writeMigrationFile } from './file-generator';
import { promptMigrationDescription, setNonInteractive } from './prompt';
import { INTERNAL_TABLES } from './schema-model';

@cli.controller('migration:create')
export class MigrationCreateCommand {
    private logger = createLogger('MigrationCreate');

    constructor(private dbProvider: DBProvider) {}

    async execute(
        nonInteractive: boolean & Flag<{ description: 'Skip interactive prompts' }> = false,
        raw: boolean & Flag<{ description: 'Emit raw dialect-specific SQL instead of dialect-portable schema-builder calls' }> = false
    ) {
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

            // Step 5: Decide if there are any changes
            const hasChanges =
                diff.addedTables.length > 0 ||
                diff.removedTables.length > 0 ||
                diff.modifiedTables.some(
                    t =>
                        t.addedColumns.length > 0 ||
                        t.removedColumns.length > 0 ||
                        t.modifiedColumns.length > 0 ||
                        t.renamedColumns.length > 0 ||
                        t.addedIndexes.length > 0 ||
                        t.removedIndexes.length > 0 ||
                        t.addedForeignKeys.length > 0 ||
                        t.removedForeignKeys.length > 0 ||
                        t.primaryKeyChanged ||
                        t.addedEnumTypes.length > 0 ||
                        t.removedEnumTypes.length > 0 ||
                        t.modifiedEnumTypes.length > 0
                );

            if (!hasChanges) {
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

            // Step 7: Render migration content (builder by default; --raw for legacy SQL)
            let filePath: string;
            pinoLogger.flush();
            await new Promise(resolve => setTimeout(resolve, 100));
            const description = await promptMigrationDescription();

            if (raw) {
                const statements = generateDDL(diff);
                this.logger.info(`\nDDL statements (${statements.length}):`);
                for (const stmt of statements) this.logger.info(`  ${stmt}`);
                filePath = generateMigrationFile(statements, description);
            } else {
                const content = generateBuilderMigrationFromDiff(diff);
                this.logger.info(`\nGenerated builder migration (${content.split('\n').length} lines)`);
                filePath = writeMigrationFile(content, description);
            }

            this.logger.info(`\nMigration file created: ${filePath}`);
        } finally {
            setNonInteractive(false);
        }
    }
}
