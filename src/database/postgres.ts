import { ClassType } from '@deepkit/core';
import { Logger } from '@deepkit/logger';
import { Database, DatabaseSession } from '@deepkit/orm';
import { PostgresConnection, PostgresDatabaseAdapter as BasePostgresDatabaseAdapter } from '@deepkit/postgres';
import { isNonUndefined } from '@deepkit/sql';
import { ReflectionKind, Type } from '@deepkit/type';
import { PoolConfig } from 'pg';

import { getAppConfig, r } from '../app/resolver';
import { globalState } from '../app/state';
import { BaseDatabase } from './common';

export type PostgresDatabaseSession = DatabaseSession<PostgresDatabaseAdapter>;

const originalRun = PostgresConnection.prototype.run;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
PostgresConnection.prototype.run = async function (sql: string, params: any[] = []) {
    await originalRun.call(this, sql, params);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { affectedRows: (this as any).changes ?? 0, insertId: 0 } as any;
};

export class PostgresDatabaseAdapter extends BasePostgresDatabaseAdapter {
    registerTransformations() {
        // any
        this.platform.serializer.deserializeRegistry.register(ReflectionKind.any, (_type, state) => {
            state.addSetter(state.accessor);
        });

        // date string
        this.platform.serializer.deserializeRegistry.addDecorator(
            t => t.typeName === 'DateString',
            (_type, state) => {
                state.addSetter(`${state.accessor} instanceof Date ? ${state.accessor}.toISOString().substring(0, 10) : ${state.accessor}`);
                state.ended = true;
            }
        );

        // when Jest/test mocks dates, the Date object checked by Deepkit is not the same as the one created by the mock
        if (process.env.APP_ENV === 'test') {
            const isDate = (t: Type) => t.kind === ReflectionKind.class && t.classType.name === 'Date';
            this.platform.addType(isDate, 'timestamp');
            this.platform.addType(t => t.kind === ReflectionKind.union && t.types.filter(isNonUndefined).every(isDate), 'timestamp');
        }
    }
}

export interface IPostgresDatabaseAdapterConfig extends PoolConfig {
    enableLocksTable?: boolean;
}

export function createPostgresDatabase(
    config: IPostgresDatabaseAdapterConfig,
    entities: ConstructorParameters<typeof Database>[1] = []
): ClassType<BaseDatabase<PostgresDatabaseAdapter>> {
    return class extends BaseDatabase<PostgresDatabaseAdapter> {
        constructor() {
            const appConfig = getAppConfig();
            const isProduction = appConfig.APP_ENV === 'production';

            const { enableLocksTable, ...otherConfig } = config;

            const ssl = appConfig.PG_SSL ? { rejectUnauthorized: appConfig.PG_SSL_REJECT_UNAUTHORIZED ?? true } : undefined;

            const adapter = new PostgresDatabaseAdapter({
                host: appConfig.PG_HOST,
                port: appConfig.PG_PORT,
                user: appConfig.PG_USER,
                password: appConfig.PG_PASSWORD_SECRET,
                database: appConfig.PG_DATABASE,
                ssl,
                max: appConfig.PG_CONNECTION_LIMIT ?? (isProduction ? 10 : 5),
                idleTimeoutMillis: (appConfig.PG_IDLE_TIMEOUT_SECONDS ?? (isProduction ? 60 : 5)) * 1000,
                ...otherConfig
            });

            adapter.registerTransformations();

            if (globalState.additionalEntities) {
                entities.push(...globalState.additionalEntities);
            }

            super(adapter, entities);

            if (enableLocksTable) {
                this.rawExecute(
                    `CREATE TABLE IF NOT EXISTS "_locks" (
                        "key" VARCHAR(255) NOT NULL PRIMARY KEY,
                        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        "lastTouched" TIMESTAMP
                    )`
                )
                    .then(() => this.rawExecute(`DELETE FROM "_locks" WHERE "lastTouched" < NOW() - INTERVAL '1 hour'`))
                    .catch(err => {
                        r(Logger).error(`Could not create _locks table: %s`, err);
                    });
            }
        }
    };
}
