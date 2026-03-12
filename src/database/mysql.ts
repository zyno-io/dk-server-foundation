import { ClassType, getClassName } from '@deepkit/core';
import { Logger } from '@deepkit/logger';
import { MySQLConnection, MySQLDatabaseAdapter as BaseMySQLDatabaseAdapter } from '@deepkit/mysql';
import { Database, DatabaseSession } from '@deepkit/orm';
import { isNonUndefined } from '@deepkit/sql';
import { databaseAnnotation, ReflectionKind, Type } from '@deepkit/type';
import { PoolConfig } from 'mariadb';

import { Coordinate } from '.';
import { getAppConfig, r } from '../app/resolver';
import { globalState } from '../app/state';
import { BaseDatabase } from './common';

export type MySQLDatabaseSession = DatabaseSession<MySQLDatabaseAdapter>;

const originalRun = MySQLConnection.prototype.run;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
MySQLConnection.prototype.run = async function (sql: string, params: any[] = []) {
    await originalRun.call(this, sql, params);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.lastExecResult?.[0] as any;
};

export class MySQLDatabaseAdapter extends BaseMySQLDatabaseAdapter {
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

        // register POINT as a coordinate
        // a specificity of 2 on the type guard allows the default object literal (at specificity 1) to match the {x,y} object
        // while allowing a fallback to match the POINT object coming from the mariadb driver
        const isCoordinateClass = (t: Type): boolean => t.kind === ReflectionKind.class && getClassName(t.classType) === 'Coordinate';
        const isCoordinateTypeName = (t: Type): boolean => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const typeName = (t as any).typeName;
            return typeName === 'MySQLCoordinate' || typeName === 'NullableMySQLCoordinate' || typeName === 'Coordinate';
        };
        const hasMySQLPointAnnotation = (t: Type): boolean => {
            const mysqlOptions = databaseAnnotation.getDatabase<{ type?: string }>(t, 'mysql');
            return mysqlOptions?.type === 'point';
        };
        const containsCoordinate = (t: Type): boolean => {
            if (isCoordinateClass(t)) return true;
            if (isCoordinateTypeName(t)) return true;
            if (hasMySQLPointAnnotation(t)) return true;
            if (t.kind === ReflectionKind.intersection) return t.types.some(containsCoordinate);
            if (t.kind === ReflectionKind.union) return t.types.filter(isNonUndefined).some(containsCoordinate);
            return false;
        };
        this.platform.addType(containsCoordinate, 'point');
        this.platform.serializer.typeGuards.registerClass(2, Coordinate, (_type, state) => {
            state.addSetter(`typeof ${state.accessor} === 'object' && ${state.accessor}.type === 'Point'`);
        });
        this.platform.serializer.serializeRegistry.registerClass(Coordinate, (_type, state) => {
            state.addCodeForSetter(`
                const c = ${state.accessor};
                ${state.setter} = { type: 'Point', coordinates: [c.x, c.y] };
            `);
            state.ended = true;
        });
        this.platform.serializer.deserializeRegistry.registerClass(Coordinate, (_type, state) => {
            state.addCodeForSetter(`
                const c = ${state.accessor};
                ${state.setter} = { x: c.coordinates[0], y: c.coordinates[1] };
            `);
            state.ended = true;
        });

        // when Jest mocks dates, the Date object checked by Deepkit is not the same as the one created by Jest
        if (process.env.APP_ENV === 'test') {
            const isDate = (t: Type) => t.kind === ReflectionKind.class && t.classType.name === 'Date';
            this.platform.addType(isDate, 'datetime');
            this.platform.addType(t => t.kind === ReflectionKind.union && t.types.filter(isNonUndefined).every(isDate), 'datetime');
        }
    }
}

export interface IMySQLDatabaseAdapterConfig extends PoolConfig {
    enableLocksTable?: boolean;
}
export function createMySQLDatabase(
    config: IMySQLDatabaseAdapterConfig,
    entities: ConstructorParameters<typeof Database>[1] = []
): ClassType<BaseDatabase<MySQLDatabaseAdapter>> {
    return class extends BaseDatabase<MySQLDatabaseAdapter> {
        constructor() {
            const appConfig = getAppConfig();
            const isProduction = appConfig.APP_ENV === 'production';

            const { enableLocksTable, ...otherConfig } = config;

            const adapter = new MySQLDatabaseAdapter({
                host: appConfig.MYSQL_HOST,
                port: appConfig.MYSQL_PORT,
                user: appConfig.MYSQL_USER,
                password: appConfig.MYSQL_PASSWORD_SECRET,
                database: appConfig.MYSQL_DATABASE,
                connectionLimit: appConfig.MYSQL_CONNECTION_LIMIT ?? (isProduction ? 10 : 5),
                minimumIdle: appConfig.MYSQL_MIN_IDLE_CONNECTIONS ?? (isProduction ? undefined : 1),
                idleTimeout: appConfig.MYSQL_IDLE_TIMEOUT_SECONDS ?? (isProduction ? 60 : 5),
                allowPublicKeyRetrieval: true,
                trace: true,
                ...otherConfig
            });

            adapter.registerTransformations();

            if (globalState.additionalEntities) {
                entities.push(...globalState.additionalEntities);
            }

            super(adapter, entities);

            if (enableLocksTable) {
                this.rawExecute(
                    `CREATE TABLE IF NOT EXISTS \`_locks\` (
                        \`key\` VARCHAR(255) NOT NULL PRIMARY KEY,
                        \`createdAt\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        \`lastTouched\` DATETIME
                    )`
                )
                    .then(() => this.rawExecute(`DELETE FROM _locks WHERE lastTouched < NOW() - INTERVAL 1 HOUR`))
                    .catch(err => {
                        r(Logger).error(`Could not create _locks table: %s`, err);
                    });
            }
        }
    };
}
