import { ClassType } from '@deepkit/core';
import { Database } from '@deepkit/orm';

import { BaseDatabase } from './common';
import { Dialect } from './dialect';
import { createMySQLDatabase, IMySQLDatabaseAdapterConfig, MySQLDatabaseAdapter } from './mysql';
import { createPostgresDatabase, IPostgresDatabaseAdapterConfig, PostgresDatabaseAdapter } from './postgres';

export type AnyDatabaseAdapter = MySQLDatabaseAdapter | PostgresDatabaseAdapter;

export interface ICommonDatabaseAdapterConfig {
    enableLocksTable?: boolean;
}

type Entities = ConstructorParameters<typeof Database>[1];

export function createDatabase(config: ICommonDatabaseAdapterConfig, entities?: Entities): ClassType<BaseDatabase<AnyDatabaseAdapter>>;
export function createDatabase(
    dialect: 'mysql',
    config: IMySQLDatabaseAdapterConfig,
    entities?: Entities
): ClassType<BaseDatabase<MySQLDatabaseAdapter>>;
export function createDatabase(
    dialect: 'postgres',
    config: IPostgresDatabaseAdapterConfig,
    entities?: Entities
): ClassType<BaseDatabase<PostgresDatabaseAdapter>>;
export function createDatabase(
    dialectOrConfig: Dialect | ICommonDatabaseAdapterConfig,
    configOrEntities?: IMySQLDatabaseAdapterConfig | IPostgresDatabaseAdapterConfig | Entities,
    maybeEntities?: Entities
): ClassType<BaseDatabase<AnyDatabaseAdapter>> {
    let dialect: Dialect;
    let config: IMySQLDatabaseAdapterConfig | IPostgresDatabaseAdapterConfig;
    let entities: Entities;

    if (typeof dialectOrConfig === 'string') {
        dialect = dialectOrConfig;
        config = configOrEntities as IMySQLDatabaseAdapterConfig | IPostgresDatabaseAdapterConfig;
        entities = maybeEntities ?? [];
    } else {
        dialect = resolveDialectFromEnv();
        config = dialectOrConfig;
        entities = (configOrEntities as Entities | undefined) ?? [];
    }

    return dialect === 'postgres'
        ? createPostgresDatabase(config as IPostgresDatabaseAdapterConfig, entities)
        : createMySQLDatabase(config as IMySQLDatabaseAdapterConfig, entities);
}

function resolveDialectFromEnv(): Dialect {
    const value = process.env.DB_ADAPTER;
    if (value === 'mysql' || value === 'postgres') return value;
    throw new Error(
        `createDatabase(sharedConfig) requires the DB_ADAPTER env var to be 'mysql' or 'postgres' (got: ${value ?? 'undefined'}). ` +
            `Either set DB_ADAPTER or call createDatabase(dialect, config) explicitly.`
    );
}
