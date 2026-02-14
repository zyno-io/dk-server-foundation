import { cli } from '@deepkit/app';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { existsSync, readdirSync } from 'fs';
import { difference } from 'lodash';
import path from 'path';

import { DBProvider, globalState } from '../../app/state';
import { createLogger } from '../../services';
import { WorkerQueueRegistry } from '../../services/worker/queue';
import { createPersistedEntity } from '../common';
import { getDialect, tableExistsSql } from '../dialect';
import { getMigrationsDir } from './helpers';
import { MigrationEntity } from './migration.entity';

@cli.controller('migration:run')
export class MigrationRunCommand {
    private logger = createLogger('Migrator');
    private migrationsDir = getMigrationsDir();

    constructor(private dbProvider: DBProvider) {}

    async execute() {
        if (!existsSync(this.migrationsDir)) {
            throw new Error('Migrations directory does not exist');
        }

        const migrations = readdirSync(this.migrationsDir)
            .filter(f => /\.[jt]s$/.test(f))
            .map(f => f.replace(/\.[jt]s$/, ''));
        migrations.sort();
        this.logger.info(`${migrations.length} migrations found in package`);

        await this.createMigrationsTableIfNotExists();

        this.dbProvider.db.registerEntity(MigrationEntity);

        const executedMigrations = await MigrationEntity.query().select('name').findField('name');
        const unexecutedMigrations = difference(migrations, executedMigrations);
        this.logger.info(`${executedMigrations.length} migrations previously executed`);
        this.logger.info(`${unexecutedMigrations.length} migrations to run`);

        const executedAt = new Date();

        for (const migration of unexecutedMigrations) {
            const startTs = Date.now();
            this.logger.info(`Running migration: ${migration}`);

            await this.runCodeMigration(migration);

            this.logger.info(`Completed migration: ${migration}`);
            await createPersistedEntity(MigrationEntity, {
                executedAt,
                name: migration,
                durationMs: Date.now() - startTs
            });
        }

        // this may seem out of place but it makes sense to do during a migration, since
        // the application is about to start and will re-register all jobs with the new schedule
        if (globalState.enableWorker) {
            const queue = WorkerQueueRegistry.getDefaultQueue();
            const repeatableJobs = await queue.getRepeatableJobs();
            for (const job of repeatableJobs) {
                this.logger.info('Removing repeatable job', { job: { name: job.name, key: job.key } });
                await queue.removeRepeatableByKey(job.key);
            }
            await WorkerQueueRegistry.closeQueues();
        }
    }

    async createMigrationsTableIfNotExists() {
        const dialect = getDialect(this.dbProvider.db.adapter as SQLDatabaseAdapter);
        const tableInfoRows = await this.dbProvider.db.rawQuery(tableExistsSql(dialect, '_migrations'));
        if (tableInfoRows.length) return;

        if (dialect === 'postgres') {
            await this.dbProvider.db.rawQuery(`
                CREATE TABLE "_migrations" (
                    "name" varchar(255) NOT NULL PRIMARY KEY,
                    "executedAt" timestamp NOT NULL,
                    "durationMs" integer NOT NULL
                )
            `);
        } else {
            await this.dbProvider.db.rawQuery(`
                CREATE TABLE _migrations (
                    name varchar(255) NOT NULL,
                    executedAt datetime NOT NULL,
                    durationMs int unsigned NOT NULL,
                    PRIMARY KEY (name)
                ) ENGINE=InnoDB
            `);
        }
    }

    async runCodeMigration(file: string) {
        let migrationModule;

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            migrationModule = require(path.join(process.cwd(), this.migrationsDir, file));
        } catch (err) {
            this.logger.error('Failed to load migration', { file });
            throw err;
        }

        if (!('default' in migrationModule) || typeof migrationModule.default !== 'function') {
            throw new Error(`Migration ${file} does not export a function`);
        }

        try {
            await migrationModule.default(this.dbProvider.db);
        } catch (err) {
            this.logger.error('Migration function failed to execute', err, { file });
            throw err;
        }
    }
}
