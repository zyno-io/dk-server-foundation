import { Database } from '@deepkit/orm';
import { SQLDatabaseAdapter } from '@deepkit/sql';
import { describe } from 'node:test';

import {
    BaseAppConfig,
    BaseDatabase,
    createMySQLDatabase,
    createPostgresDatabase,
    IMySQLDatabaseAdapterConfig,
    IPostgresDatabaseAdapterConfig,
    ITestingFacadeOptions,
    TestingFacade,
    TestingHelpers
} from '../../src';

interface IDBTestingFacadeOptions extends ITestingFacadeOptions {
    dbType?: 'mysql' | 'postgres';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controllers?: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    providers?: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    imports?: any[];
    entities: ConstructorParameters<typeof Database>[1];
    mysqlConfig?: IMySQLDatabaseAdapterConfig;
    pgConfig?: IPostgresDatabaseAdapterConfig;
}

type ExtendedTF = TestingFacade & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DB: any;
    getDb: () => BaseDatabase;
    createTables: () => Promise<void>;
};

export function createTestingFacadeWithDatabase(options?: IDBTestingFacadeOptions): ExtendedTF {
    const dbType = options?.dbType ?? 'mysql';
    const { controllers, providers, imports, mysqlConfig, pgConfig, entities, dbType: _, ...testingFacadeOptions } = options ?? {};

    if (dbType === 'postgres') {
        TestingHelpers.setDefaultDatabaseConfig({
            PG_HOST: process.env.PG_HOST ?? 'localhost',
            PG_PORT: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : 5432,
            PG_USER: process.env.PG_USER ?? 'root',
            PG_PASSWORD_SECRET: process.env.PG_PASSWORD_SECRET ?? 'secret'
        });
    } else {
        TestingHelpers.setDefaultDatabaseConfig({
            MYSQL_HOST: 'localhost',
            MYSQL_PORT: 3306,
            MYSQL_USER: 'root',
            MYSQL_PASSWORD_SECRET: 'secret'
        });
    }

    const dbClass = dbType === 'postgres' ? createPostgresDatabase(pgConfig ?? {}, entities) : createMySQLDatabase(mysqlConfig ?? {}, entities);

    const tf = TestingHelpers.createTestingFacade(
        {
            controllers,
            providers,
            imports,
            db: dbClass,
            config: BaseAppConfig
        },
        {
            enableDatabase: true,
            enableMigrations: false,
            databasePrefix: dbType === 'postgres' ? 'dksf_pg_test' : 'dksf_test',
            dbAdapter: dbType,
            ...testingFacadeOptions
        }
    );

    const getDb = () => tf.app.get(dbClass) as BaseDatabase;
    const createTables = () => (getDb().adapter as SQLDatabaseAdapter).createTables(getDb().entityRegistry);

    Object.assign(tf, { DB: dbClass, getDb, createTables });
    return tf as ExtendedTF;
}

export interface AdapterDescriptor {
    name: string;
    type: 'mysql' | 'postgres';
    createFacade: (options?: IDBTestingFacadeOptions) => ExtendedTF;
}

const allAdapters: AdapterDescriptor[] = [
    { name: 'MySQL', type: 'mysql', createFacade: opts => createTestingFacadeWithDatabase({ ...opts!, dbType: 'mysql' }) },
    { name: 'PostgreSQL', type: 'postgres', createFacade: opts => createTestingFacadeWithDatabase({ ...opts!, dbType: 'postgres' }) }
];

export function forEachAdapter(fn: (adapter: AdapterDescriptor) => void) {
    for (const adapter of allAdapters) {
        describe(adapter.name, () => fn(adapter));
    }
}
