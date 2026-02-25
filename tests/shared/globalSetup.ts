import { TestingHelpers } from '../../src';

export async function setup() {
    process.env.TZ = 'UTC';

    TestingHelpers.setDefaultDatabaseConfig({
        MYSQL_HOST: 'localhost',
        MYSQL_PORT: 3306,
        MYSQL_USER: 'root',
        MYSQL_PASSWORD_SECRET: 'secret',
        PG_HOST: 'localhost',
        PG_PORT: 5432,
        PG_USER: 'root',
        PG_PASSWORD_SECRET: 'secret'
    });

    await TestingHelpers.cleanupTestDatabases('dksf_test');
    await cleanupPgTestDatabases();
}

export async function teardown() {
    await TestingHelpers.cleanupTestDatabases('dksf_test');
    await cleanupPgTestDatabases();
}

async function cleanupPgTestDatabases() {
    const prevAdapter = process.env.DB_ADAPTER;
    process.env.DB_ADAPTER = 'postgres';
    await TestingHelpers.cleanupTestDatabases('dksf_pg_test');
    if (prevAdapter === undefined) {
        delete process.env.DB_ADAPTER;
    } else {
        process.env.DB_ADAPTER = prevAdapter;
    }
}
