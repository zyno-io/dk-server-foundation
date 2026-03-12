import { ClassType } from '@deepkit/core';
import { MySQLDatabaseAdapter } from '@deepkit/mysql';
import { DatabasePersistence, MemoryDatabaseAdapter, MemoryQueryFactory, OrmEntity } from '@deepkit/orm';
import { PostgresDatabaseAdapter } from '@deepkit/postgres';
import { ReflectionClass } from '@deepkit/type';
import { mock } from 'node:test';

import { EntityFields } from '../database';

export class SqlTestingHelper {
    private mdbAdapter?: MemoryDatabaseAdapter;
    private mdbPersistence?: DatabasePersistence;

    mockEntity<T extends OrmEntity>(entityCls: ClassType<T>, data: Partial<EntityFields<T>>[] | Partial<EntityFields<T>>) {
        const entityRefCls = ReflectionClass.from(entityCls);
        this.mdbAdapter ??= new MemoryDatabaseAdapter();
        this.mdbPersistence ??= this.mdbAdapter.createPersistence();
        this.mdbPersistence.insert(entityRefCls, Array.isArray(data) ? data : [data]);
        this.installMocks();
    }

    clearMocks() {
        this.mdbAdapter?.['store'].clear();
    }

    installMocks() {
        // Mock MySQL adapter
        const mysqlQfDescriptor = Object.getOwnPropertyDescriptor(MySQLDatabaseAdapter.prototype, 'queryFactory');
        if (!(mysqlQfDescriptor && 'value' in mysqlQfDescriptor && mysqlQfDescriptor.value?.mock)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mock.method(MySQLDatabaseAdapter.prototype, 'queryFactory', (session: any) => this.mdbAdapter!.queryFactory(session) as any);
        }

        // Mock Postgres adapter
        const pgQfDescriptor = Object.getOwnPropertyDescriptor(PostgresDatabaseAdapter.prototype, 'queryFactory');
        if (!(pgQfDescriptor && 'value' in pgQfDescriptor && pgQfDescriptor.value?.mock)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mock.method(PostgresDatabaseAdapter.prototype, 'queryFactory', (session: any) => this.mdbAdapter!.queryFactory(session) as any);
        }

        const mdbAdapter = this.mdbAdapter;
        const originalCreateQuery = MemoryQueryFactory.prototype.createQuery;
        mock.method(MemoryQueryFactory.prototype, 'createQuery', function (this: MemoryQueryFactory, entity: ClassType) {
            const entityRefCls = ReflectionClass.from(entity);
            if (!mdbAdapter?.['store'].has(entityRefCls)) {
                throw new Error(`No mock data found for entity: ${entityRefCls.getClassName()}`);
            }
            return originalCreateQuery.call(this, entity);
        });
    }
}
