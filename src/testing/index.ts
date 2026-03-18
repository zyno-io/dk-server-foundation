import { App, RootModuleDefinition } from '@deepkit/app';
import { ClassType } from '@deepkit/core';
import { ApplicationServer, TestingFacade as BaseTestingFacade } from '@deepkit/framework';
import { MySQLDatabaseAdapter } from '@deepkit/mysql';
import { DatabaseRegistry } from '@deepkit/orm';
import { PostgresDatabaseAdapter } from '@deepkit/postgres';
import { SQLDatabaseAdapter } from '@deepkit/sql';

import { BaseAppConfig, createApp, CreateAppOptions } from '../app';
import { globalState } from '../app/state';
import { runMigrations } from '../database';
import { sleepMs } from '../helpers';
import { defineEntityFixtures, loadEntityFixtures, prepareEntityFixtures } from './fixtures';
import { installStandardHooks, makeMockRequest, resetSrcModuleCache } from './requests';
import { SqlTestingHelper } from './sql';

process.env.TEST_RUN_TS ??= String(Math.floor(Date.now() / 1000));

let nextPoolId = 1;

export type TestDbAdapter = 'mysql' | 'postgres';

function getTestDbAdapter(): TestDbAdapter {
    if (process.env.DB_ADAPTER === 'postgres' || process.env.DB_ADAPTER === 'mysql') {
        return process.env.DB_ADAPTER;
    }
    if (process.env.PG_HOST) return 'postgres';
    return 'mysql';
}

export interface ITestingFacadeOptions {
    enableDatabase?: boolean;
    enableMigrations?: boolean;
    autoSeedData?: boolean;
    useSavepoints?: boolean;
    databasePrefix?: string;
    dbAdapter?: TestDbAdapter;
    onBeforeStart?: (facade: TestingFacade) => Promise<void>;
    onStart?: (facade: TestingFacade) => Promise<void>;
    onBeforeStop?: (facade: TestingFacade) => Promise<void>;
    onStop?: (facade: TestingFacade) => Promise<void>;
    seedData?: (facade: TestingFacade) => Promise<void>;
    defaultTestHeaders?: Record<string, string>;
}

export class TestingFacade<A extends RootModuleDefinition = RootModuleDefinition> extends BaseTestingFacade<App<A>> {
    public sql = new SqlTestingHelper();
    public startTs = 0;
    public databaseName?: string;
    public dbAdapter: TestDbAdapter;
    public savepointIsolationActive = false;
    private stopped = false;
    private httpServer?: import('net').Server;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private savepointConnection?: any;
    private savepointCleanup?: () => void;

    constructor(
        app: App<A>,
        public readonly options: ITestingFacadeOptions = {}
    ) {
        super(app);
        this.dbAdapter = options.dbAdapter ?? getTestDbAdapter();
    }

    private get shouldUseSavepoints(): boolean {
        if (this.options?.useSavepoints !== undefined) return this.options.useSavepoints;
        return !!this.options?.enableDatabase;
    }

    public async start() {
        if (this.options?.enableDatabase) {
            await this.createDatabase();
        }

        await this.options?.onBeforeStart?.(this);

        if (this.databaseName) {
            if (this.dbAdapter === 'postgres') {
                process.env.PG_DATABASE = this.databaseName;
            } else {
                process.env.MYSQL_DATABASE = this.databaseName;
            }
        }

        // Ensure globalState points to this app before starting the server.
        // When multiple test facades are created (e.g. forEachAdapter), the last
        // createApp() call wins. Without this, the DB constructor's getAppConfig()
        // would resolve against the wrong app, eagerly loading its config from
        // stale env vars.
        globalState.currentApp = this.app;

        await this.startServer();

        try {
            const appServer = this.app.get(ApplicationServer);
            const worker = appServer.getWorker();
            this.httpServer = worker['server']!;
            this.httpServer.on('listening', () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                process.stdout.write(`HTTP listening at http://127.0.0.1:${(this.httpServer!.address() as any).port}.\n`);
            });

            this.startTs = Date.now();

            await this.options?.onStart?.(this);

            if (this.options?.enableDatabase) {
                if (this.options?.enableMigrations !== false) {
                    await this.runMigrations();
                    await this.truncateTables();
                }

                if (!this.shouldUseSavepoints && this.options?.autoSeedData) {
                    await this.options?.seedData?.(this);
                }
            }
        } catch (err) {
            await this.stop();
            throw err;
        }
    }

    public async stop() {
        if (this.stopped) return;
        this.stopped = true;

        await this.options?.onBeforeStop?.(this);

        if (this.savepointIsolationActive) {
            await this.teardownSavepointIsolation();
        }

        // if the server is running for too short of a time, the database handshake
        // gets interrupted and the client hangs due to poor behaivor. thus,
        // we ensure we wait a minimum duration prior to telling the server to shut down.
        const durationMs = Date.now() - this.startTs;
        const waitMs = Math.max(0, 500 - durationMs);
        if (waitMs) await sleepMs(waitMs);
        await this.stopServer(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.httpServer as any)?.closeAllConnections?.();

        if (this.options?.enableDatabase) {
            try {
                this.app.get(DatabaseRegistry).onShutDown();
            } catch {
                // pool may already be closed if start() failed partway through
            }
        }

        await this.options?.onStop?.(this);
    }

    /**
     * ADDITIONS
     */

    public async createDatabase() {
        const ts = process.env.TEST_RUN_TS ?? Math.floor(Date.now() / 1000);
        const poolId = nextPoolId++;
        this.databaseName = `${this.options?.databasePrefix ?? 'test'}_${ts}_${process.pid}_${poolId}`;

        if (this.dbAdapter === 'postgres') {
            const pgAdapter = new PostgresDatabaseAdapter({
                host: process.env.PG_HOST,
                port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : 5432,
                user: process.env.PG_USER,
                password: process.env.PG_PASSWORD_SECRET,
                database: 'postgres'
            });
            const pgConn = await pgAdapter.connectionPool.getConnection();
            await pgConn.run(`CREATE DATABASE "${this.databaseName}"`);
            await pgConn.release();
            await pgAdapter.disconnect();
        } else {
            const dbAdapter = new MySQLDatabaseAdapter({
                host: process.env.MYSQL_HOST,
                port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3306,
                user: process.env.MYSQL_USER,
                password: process.env.MYSQL_PASSWORD_SECRET,
                database: 'mysql',
                allowPublicKeyRetrieval: true,
                trace: true
            });
            const dbConn = await dbAdapter.connectionPool.getConnection();
            await dbConn.run(`CREATE DATABASE IF NOT EXISTS ${this.databaseName}`);
            await dbConn.release();
            await dbAdapter.disconnect();
        }
    }

    public async destroyDatabase() {
        if (!this.databaseName || process.env.TEST_KEEP_DB) return;

        if (this.dbAdapter === 'postgres') {
            const pgAdapter = new PostgresDatabaseAdapter({
                host: process.env.PG_HOST,
                port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : 5432,
                user: process.env.PG_USER,
                password: process.env.PG_PASSWORD_SECRET,
                database: 'postgres'
            });
            const pgConn = await pgAdapter.connectionPool.getConnection();
            await pgConn.run(`DROP DATABASE IF EXISTS "${this.databaseName}"`);
            await pgConn.release();
            await pgAdapter.disconnect();
        } else {
            const dbAdapter = new MySQLDatabaseAdapter({
                host: process.env.MYSQL_HOST,
                port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3306,
                user: process.env.MYSQL_USER,
                password: process.env.MYSQL_PASSWORD_SECRET,
                database: 'mysql',
                allowPublicKeyRetrieval: true,
                trace: true
            });
            const dbConn = await dbAdapter.connectionPool.getConnection();
            await dbConn.run(`DROP DATABASE IF EXISTS ${this.databaseName}`);
            await dbConn.release();
            await dbAdapter.disconnect();
        }
    }

    public async truncateTables() {
        if (this.dbAdapter === 'postgres') {
            const pgAdapter = new PostgresDatabaseAdapter({
                host: process.env.PG_HOST,
                port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : 5432,
                user: process.env.PG_USER,
                password: process.env.PG_PASSWORD_SECRET,
                database: this.databaseName!
            });
            const pgConn = await pgAdapter.connectionPool.getConnection();
            try {
                const result = await pgConn.execAndReturnAll(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tables = result.map((row: any) => row.tablename);
                for (const table of tables) {
                    if (table === '_migrations') continue;
                    await pgConn.run(`TRUNCATE TABLE "${table}" CASCADE`);
                }
            } finally {
                await pgConn.release();
                await pgAdapter.disconnect();
            }
        } else {
            const dbAdapter = new MySQLDatabaseAdapter({
                host: process.env.MYSQL_HOST,
                port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3306,
                user: process.env.MYSQL_USER,
                password: process.env.MYSQL_PASSWORD_SECRET,
                database: this.databaseName!,
                allowPublicKeyRetrieval: true,
                trace: true
            });
            const dbConn = await dbAdapter.connectionPool.getConnection();
            try {
                const result = await dbConn.execAndReturnAll('SHOW TABLES');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tables = result.map((row: any) => Object.values(row)[0]);
                for (const table of tables) {
                    if (table === '_migrations') continue;
                    await dbConn.run(`TRUNCATE TABLE ${table}`);
                }
            } finally {
                await dbConn.release();
                await dbAdapter.disconnect();
            }
        }
    }

    public async runMigrations() {
        await runMigrations();
    }

    public async resetToSeed() {
        if (!this.options?.enableDatabase) return;

        if (this.shouldUseSavepoints) {
            if (!this.savepointIsolationActive) {
                // Lazily initialize savepoint isolation on first resetToSeed call.
                // This ensures tables exist (e.g. createTables() called after start()).
                await this.initSavepointIsolation();
            } else {
                await this.savepointConnection.run('ROLLBACK TO SAVEPOINT after_seed');
            }
            return;
        }

        await this.truncateTables();
        await this.options?.seedData?.(this);
    }

    /**
     * Savepoint isolation: instead of truncating all tables and re-seeding between
     * tests, we wrap all test activity in a transaction and use SAVEPOINT/ROLLBACK TO
     * to restore the database to its post-seed state. This is dramatically faster than
     * TRUNCATE on large schemas.
     *
     * How it works:
     * 1. Seed data is loaded within a transaction on a dedicated connection
     * 2. A savepoint (after_seed) captures the post-seed state
     * 3. The connection pool is hijacked so all queries use this connection
     * 4. App-level transactions (db.transaction()) become nested savepoints
     * 5. Between tests, ROLLBACK TO SAVEPOINT restores the seed state instantly
     */
    private async initSavepointIsolation() {
        const databases = this.app.get(DatabaseRegistry).getDatabases();
        if (databases.length === 0) return;

        const db = databases[0];
        const adapter = db.adapter as SQLDatabaseAdapter;
        const pool = adapter.connectionPool;

        // Get a connection and start a wrapping transaction
        const conn = await pool.getConnection();
        this.savepointConnection = conn;

        await conn.run('START TRANSACTION');

        // Seed data within the transaction
        if (this.options?.seedData) {
            await this.options.seedData(this);
        }

        // Create the savepoint we'll rollback to between tests
        await conn.run('SAVEPOINT after_seed');

        // Store originals for cleanup
        const origGetConnection = pool.getConnection.bind(pool);
        const origRelease = conn.release.bind(conn);

        let spCounter = 0;

        // Hijack getConnection to always return our held connection.
        // Transaction begin/commit/rollback are patched per-instance (not on the
        // prototype) so that multiple facades can coexist safely.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool.getConnection = async (transaction?: any) => {
            if (transaction) {
                if (transaction.connection) return transaction.connection;
                transaction.connection = conn;

                // Patch this transaction instance to use savepoints
                const spName = `sp_${++spCounter}`;
                transaction.begin = async function () {
                    if (!this.connection) return;
                    await this.connection.run(`SAVEPOINT ${spName}`);
                };
                transaction.commit = async function () {
                    if (!this.connection) return;
                    if (this.ended) throw new Error('Transaction ended already');
                    await this.connection.run(`RELEASE SAVEPOINT ${spName}`);
                    this.ended = true;
                };
                transaction.rollback = async function () {
                    if (!this.connection) return;
                    if (this.ended) throw new Error('Transaction ended already');
                    await this.connection.run(`ROLLBACK TO SAVEPOINT ${spName}`);
                    this.ended = true;
                };

                try {
                    await transaction.begin();
                } catch (error) {
                    transaction.ended = true;
                    throw new Error('Could not start transaction: ' + error);
                }
            }
            return conn;
        };

        // Make release a no-op so the connection stays held
        conn.release = () => {};

        this.savepointIsolationActive = true;
        this.savepointCleanup = () => {
            pool.getConnection = origGetConnection;
            conn.release = origRelease;
        };
    }

    private async teardownSavepointIsolation() {
        if (!this.savepointIsolationActive) return;

        this.savepointCleanup!();
        try {
            await this.savepointConnection.run('ROLLBACK');
        } catch {
            // connection may already be broken
        }
        this.savepointIsolationActive = false;
        this.savepointConnection = undefined;
        this.savepointCleanup = undefined;
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TestingAppOptions<C> = Omit<CreateAppOptions<any>, 'config'> & { config?: ClassType<C> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTestingFacade<O extends TestingAppOptions<any>>(appOptions: O, options?: ITestingFacadeOptions) {
    const adapter = getTestDbAdapter();
    if (!options?.enableDatabase) {
        if (adapter === 'mysql') {
            process.env.MYSQL_MIN_IDLE_CONNECTIONS = '0';
        }
    }
    const app = createApp({
        config: BaseAppConfig,
        ...appOptions,
        frameworkConfig: {
            ...appOptions.frameworkConfig,
            port: 0,
            compression: 0
        }
    });
    return new TestingFacade(app, options);
}

type MySQLConfig = Pick<BaseAppConfig, 'MYSQL_HOST' | 'MYSQL_PORT' | 'MYSQL_USER' | 'MYSQL_PASSWORD_SECRET'>;
type PGConfig = Pick<BaseAppConfig, 'PG_HOST' | 'PG_PORT' | 'PG_USER' | 'PG_PASSWORD_SECRET'>;

function setDefaultDatabaseConfig(config: MySQLConfig | PGConfig) {
    Object.assign(process.env, { ...config, ...process.env });
    if ('PG_HOST' in config) {
        process.env.PG_DATABASE ??= '_fake_database_';
    } else {
        process.env.MYSQL_DATABASE ??= '_fake_database_';
    }
}

async function cleanupTestDatabases(prefix?: string, except?: string) {
    const dbNameRe = new RegExp(`^${prefix ?? 'test'}_(\\d+)_(\\d+)_(\\d+)$`);
    const adapter = getTestDbAdapter();

    function isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    function shouldDrop(db: string): boolean {
        if (db === except) return false;
        const match = db.match(dbNameRe);
        if (!match) return false;
        const pid = parseInt(match[2]);
        return !isProcessAlive(pid);
    }

    if (adapter === 'postgres') {
        const pgAdapter = new PostgresDatabaseAdapter({
            host: process.env.PG_HOST,
            port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : 5432,
            user: process.env.PG_USER,
            password: process.env.PG_PASSWORD_SECRET,
            database: 'postgres'
        });
        const pgConn = await pgAdapter.connectionPool.getConnection();
        const result = await pgConn.execAndReturnAll(`SELECT datname AS "Database" FROM pg_database WHERE datistemplate = false`);
        const dbs = result.map((r: { Database: string }) => r.Database).filter((db: string) => dbNameRe.test(db));
        for (const db of dbs) {
            if (!shouldDrop(db)) continue;
            await pgConn.run(`DROP DATABASE "${db}"`);
        }
        await pgConn.release();
        await pgAdapter.disconnect();
    } else {
        const dbAdapter = new MySQLDatabaseAdapter({
            host: process.env.MYSQL_HOST,
            port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3306,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD_SECRET,
            database: 'mysql',
            allowPublicKeyRetrieval: true,
            trace: true
        });
        const dbConn = await dbAdapter.connectionPool.getConnection();
        const result = await dbConn.execAndReturnAll(`SHOW DATABASES`);
        const dbs = result.map((r: { Database: string }) => r.Database).filter((db: string) => dbNameRe.test(db));
        for (const db of dbs) {
            if (!shouldDrop(db)) continue;
            await dbConn.run(`DROP DATABASE ${db}`);
        }
        await dbConn.release();
        await dbAdapter.disconnect();
    }
}

export const TestingHelpers = {
    setDefaultDatabaseConfig,
    createTestingFacade,
    cleanupTestDatabases,
    defineEntityFixtures,
    prepareEntityFixtures,
    loadEntityFixtures,
    makeMockRequest,
    installStandardHooks,
    resetSrcModuleCache
};
