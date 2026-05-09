import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { BaseAppConfig, BaseDatabase, createDatabase, MySQLDatabaseAdapter, PostgresDatabaseAdapter, TestingFacade, TestingHelpers } from '../../src';

describe('createDatabase', () => {
    describe('shared form (DB_ADAPTER)', () => {
        const originalAdapter = process.env.DB_ADAPTER;
        after(() => {
            if (originalAdapter === undefined) delete process.env.DB_ADAPTER;
            else process.env.DB_ADAPTER = originalAdapter;
        });

        it('throws when DB_ADAPTER is unset', () => {
            delete process.env.DB_ADAPTER;
            assert.throws(() => createDatabase({}), /DB_ADAPTER/);
        });

        it('throws when DB_ADAPTER is invalid', () => {
            process.env.DB_ADAPTER = 'sqlite';
            assert.throws(() => createDatabase({}), /DB_ADAPTER/);
        });

        it('returns a BaseDatabase subclass when DB_ADAPTER=mysql', () => {
            process.env.DB_ADAPTER = 'mysql';
            const Cls = createDatabase({});
            assert.equal(typeof Cls, 'function');
            assert.ok(Cls.prototype instanceof BaseDatabase);
        });

        it('returns a BaseDatabase subclass when DB_ADAPTER=postgres', () => {
            process.env.DB_ADAPTER = 'postgres';
            const Cls = createDatabase({});
            assert.equal(typeof Cls, 'function');
            assert.ok(Cls.prototype instanceof BaseDatabase);
        });
    });

    describe('explicit form', () => {
        it('returns a BaseDatabase subclass for mysql', () => {
            const Cls = createDatabase('mysql', {});
            assert.ok(Cls.prototype instanceof BaseDatabase);
        });

        it('returns a BaseDatabase subclass for postgres', () => {
            const Cls = createDatabase('postgres', {});
            assert.ok(Cls.prototype instanceof BaseDatabase);
        });
    });

    describe('integration: produces a working database', () => {
        const modes: { dbType: 'mysql' | 'postgres'; useShared: boolean }[] = [
            { dbType: 'mysql', useShared: false },
            { dbType: 'mysql', useShared: true },
            { dbType: 'postgres', useShared: false },
            { dbType: 'postgres', useShared: true }
        ];

        for (const { dbType, useShared } of modes) {
            describe(`${dbType} via ${useShared ? 'shared' : 'explicit'} form`, () => {
                let tf: TestingFacade;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let dbClass: any;
                const originalAdapter = process.env.DB_ADAPTER;

                before(
                    async () => {
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

                        if (useShared) {
                            process.env.DB_ADAPTER = dbType;
                            dbClass = createDatabase({});
                        } else {
                            dbClass = dbType === 'postgres' ? createDatabase('postgres', {}) : createDatabase('mysql', {});
                        }

                        tf = TestingHelpers.createTestingFacade(
                            { db: dbClass, config: BaseAppConfig },
                            {
                                enableDatabase: true,
                                enableMigrations: false,
                                databasePrefix: dbType === 'postgres' ? 'dksf_pg_test' : 'dksf_test',
                                dbAdapter: dbType
                            }
                        );
                        await tf.start();
                    },
                    { timeout: 10_000 }
                );

                after(
                    async () => {
                        await tf?.stop();
                        if (originalAdapter === undefined) delete process.env.DB_ADAPTER;
                        else process.env.DB_ADAPTER = originalAdapter;
                    },
                    { timeout: 10_000 }
                );

                it('wires up the expected adapter and runs a query', { timeout: 10_000 }, async () => {
                    const db = tf.app.get(dbClass) as BaseDatabase;
                    const expected = dbType === 'postgres' ? PostgresDatabaseAdapter : MySQLDatabaseAdapter;
                    assert.ok(db.adapter instanceof expected, `expected ${dbType} adapter`);

                    const rows = await db.rawQuery('SELECT 1 AS one');
                    assert.equal(rows.length, 1);
                });
            });
        }
    });
});
