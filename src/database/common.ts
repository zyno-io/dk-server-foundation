import { AbstractClassType, ClassType, TypeAnnotation } from '@deepkit/core';
import { HttpNotFoundError } from '@deepkit/http';
import { ActiveRecord, ActiveRecordClassType, Database, DatabaseAdapter, DatabaseSession, FilterQuery, ItemNotFound, OrmEntity } from '@deepkit/orm';
import { sql, SQLDatabaseAdapter, SQLDatabaseQuery, SqlQuery } from '@deepkit/sql';
import { AutoIncrement, deserialize, ReceiveType, ReflectionClass, Type } from '@deepkit/type';
import { pick } from 'lodash';

import { flattenMutexKey, MutexKey } from '../helpers';
import { ObjectKeysMatching } from '../types';
import { getDialect } from './dialect';

const PreCommitHooksSymbol = Symbol('PreCommitHooks');
const PostCommitHooksSymbol = Symbol('PostCommitHooks');

declare module '@deepkit/orm' {
    interface DatabaseSession {
        [PreCommitHooksSymbol]?: (() => Promise<void>)[];
        [PostCommitHooksSymbol]?: (() => Promise<void>)[];
        addPreCommitHook(hook: () => Promise<void>): void;
        addPostCommitHook(hook: () => Promise<void>): void;
        acquireSessionLock(key: MutexKey | MutexKey[]): Promise<void>;
    }
}

DatabaseSession.prototype.addPreCommitHook = function (hook: () => Promise<void>) {
    if (!this[PreCommitHooksSymbol]) this[PreCommitHooksSymbol] = [];
    this[PreCommitHooksSymbol]!.push(hook);
};

DatabaseSession.prototype.addPostCommitHook = function (hook: () => Promise<void>) {
    if (!this[PostCommitHooksSymbol]) this[PostCommitHooksSymbol] = [];
    this[PostCommitHooksSymbol]!.push(hook);
};

type LocksAdapterState = SQLDatabaseAdapter & { _enableLocksTable?: boolean; _locksTableInit?: Promise<void> };

async function ensureMysqlLocksTable(adapter: SQLDatabaseAdapter): Promise<void> {
    const a = adapter as LocksAdapterState;
    if (!a._enableLocksTable) return; // creator opted out
    if (a._locksTableInit) {
        await a._locksTableInit;
        return;
    }
    a._locksTableInit = (async () => {
        const conn = await adapter.connectionPool.getConnection();
        try {
            await conn.run(
                `CREATE TABLE IF NOT EXISTS \`_locks\` (
                    \`key\` VARCHAR(255) NOT NULL PRIMARY KEY,
                    \`createdAt\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    \`lastTouched\` DATETIME
                )`,
                []
            );
            await conn.run(`DELETE FROM _locks WHERE lastTouched < NOW() - INTERVAL 1 HOUR`, []);
        } finally {
            conn.release();
        }
    })();
    await a._locksTableInit;
}

DatabaseSession.prototype.acquireSessionLock = async function (key: MutexKey | MutexKey[]) {
    const flattenedKey = flattenMutexKey(key);
    const adapter = this.adapter as SQLDatabaseAdapter;
    const dialect = getDialect(adapter);

    if (dialect === 'postgres') {
        // use a transaction-scoped advisory lock — automatically released on commit/rollback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lockQuery = adapter.rawFactory(this as any).create(sql`SELECT pg_advisory_xact_lock(hashtext(${flattenedKey})::bigint)`);
        await lockQuery.find();
    } else {
        // the idea here is to create a new row outside the transaction so that a primary key index lock isn't obtained
        // then we can use an in-transaction row level update so that a row-level lock is acquired
        // this will be automatically released when the transaction is committed or rolled back

        // Lazy-initialize the _locks table on first use (gated by createMySQLDatabase's enableLocksTable flag).
        // This avoids a constructor-time fire-and-forget that would race with pool teardown for fast CLIs.
        await ensureMysqlLocksTable(adapter);

        // insert the lock row outside the transaction on a separate connection
        const insertConn = await adapter.connectionPool.getConnection();
        try {
            await insertConn.run(`INSERT IGNORE INTO _locks (\`key\`) VALUES (?)`, [flattenedKey]);
        } finally {
            insertConn.release();
        }

        // update in-transaction to acquire row-level lock
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updateQuery = adapter.rawFactory(this as any).create(sql`UPDATE _locks SET lastTouched=NOW() WHERE \`key\` = ${flattenedKey}`);
        await updateQuery.execute();
    }
};

// todo: swapping DatabaseAdapter for SQLDatabaseAdapter, which exposes "platform", seems to break
// types for reasons TBD
type QueryClassType<T> = ReceiveType<T> | ClassType<T> | AbstractClassType<T> | ReflectionClass<T>;
export class BaseDatabase<A extends DatabaseAdapter = DatabaseAdapter> extends Database<A> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(adapter: A, schemas?: (Type | ClassType | ReflectionClass<any>)[]) {
        super(adapter, schemas);

        // we don't like the default "clone" behavior of the query builder
        // todo: ideally we could keep .clone but only have it actually perform the clone if it's called from outside the lib
        const originalQuery = this.query;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.query as any) = <T extends OrmEntity>(type: QueryClassType<T>, txn?: DatabaseSession<DatabaseAdapter>) => {
            const result = txn ? txn.query(type) : (originalQuery.apply(this, [type]) as unknown as SQLDatabaseQuery<T>);
            result.clone = () => result;
            return result;
        };
    }

    // override existing definition
    declare query: <T extends OrmEntity>(type?: QueryClassType<T>, txn?: DatabaseSession<DatabaseAdapter>) => SQLDatabaseQuery<T>;

    private _schema?: import('./schema').Schema;

    /** Multi-dialect schema builder. See src/database/schema/. */
    get schema(): import('./schema').Schema {
        if (!this._schema) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { Schema, MySQLGrammar, PostgresGrammar } = require('./schema') as typeof import('./schema');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getDialect } = require('./dialect') as typeof import('./dialect');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getAppConfig } = require('../app/resolver') as typeof import('../app/resolver');
            const dialect = getDialect(this.adapter as unknown as import('@deepkit/sql').SQLDatabaseAdapter);
            const pgSchema = dialect === 'postgres' ? (getAppConfig().PG_SCHEMA ?? 'public') : 'public';
            const grammar = dialect === 'postgres' ? new PostgresGrammar(pgSchema) : new MySQLGrammar(pgSchema);
            this._schema = new Schema(this, grammar);
        }
        return this._schema;
    }

    async transaction<T>(callback: (session: DatabaseSession<A>) => Promise<T>): Promise<T> {
        let session_: DatabaseSession<DatabaseAdapter> | undefined;
        const result = await super.transaction(async session => {
            session_ = session;
            session.withIdentityMap = false;
            const result = await callback(session);
            if (session[PreCommitHooksSymbol]) {
                await session.flush();
                for (const hook of session[PreCommitHooksSymbol]!) {
                    await hook();
                }
            }
            return result;
        });
        if (session_?.[PostCommitHooksSymbol]) {
            for (const hook of session_[PostCommitHooksSymbol]!) {
                await hook();
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return result as any; // todo: types
    }

    async session<T>(worker: (session: DatabaseSession<A>) => Promise<T>): Promise<T> {
        return super.session(async session => {
            session.withIdentityMap = false;
            return worker(session);
        });
    }

    async withTransaction<R>(txn: DatabaseSession<A> | undefined, callback: (session: DatabaseSession<A>) => Promise<R>): Promise<R> {
        if (txn) {
            return await callback(txn);
        } else {
            return await this.transaction(async txn => callback(txn));
        }
    }

    async withSession<R>(session: DatabaseSession<A> | undefined, callback: (session: DatabaseSession<A>) => Promise<R>): Promise<R> {
        if (session) {
            return await callback(session);
        } else {
            return await this.session(async session => callback(session));
        }
    }

    async rawExecute(
        sqlIn: SqlQuery | string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        existingSession?: DatabaseSession<any>
    ): Promise<{ affectedRows: number; insertId: number; warningStatus: number }> {
        return this.withSession(existingSession, async session => {
            if (!(session.adapter instanceof SQLDatabaseAdapter)) {
                throw new Error('Cannot perform raw query on non-SQL database');
            }

            // raw queries executed against a session likely expect the data to already be written,
            // so let's flush everything we have already queued up
            if (existingSession) {
                await session.flush();
            }

            const adapter = session.adapter as SQLDatabaseAdapter;
            const sqlQuery = typeof sqlIn === 'string' ? new SqlQuery([sqlIn]) : sqlIn;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawQuery = adapter.rawFactory(session as any).create(sqlQuery);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return rawQuery.execute() as any;
        });
    }

    async rawExecuteUnsafe(
        sqlIn: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bindings: any[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        existingSession?: DatabaseSession<any>
    ): Promise<{ affectedRows: number; insertId: number; warningStatus: number }> {
        return this.rawExecute(this.createSqlQuery(sqlIn, bindings), existingSession);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rawQuery(sqlIn: SqlQuery | string, existingSession?: DatabaseSession<any>) {
        return this.withSession(existingSession, async session => {
            if (!(session.adapter instanceof SQLDatabaseAdapter)) {
                throw new Error('Cannot perform raw query on non-SQL database');
            }

            // raw queries executed against a session likely expect the data to already be written,
            // so let's flush everything we have already queued up
            if (existingSession) {
                await session.flush();
            }

            const adapter = session.adapter as SQLDatabaseAdapter;
            const sqlQuery = typeof sqlIn === 'string' ? new SqlQuery([sqlIn]) : sqlIn;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawQuery = adapter.rawFactory(session as any).create(sqlQuery);
            return await rawQuery.find();
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rawFind<T>(sqlIn: SqlQuery | string, existingSession?: DatabaseSession<any>, type?: ReceiveType<T>): Promise<T[]> {
        const rows = await this.rawQuery(sqlIn, existingSession);
        return type
            ? rows.map(row => deserialize<T>(row, undefined, (this.adapter as unknown as SQLDatabaseAdapter).platform.serializer, undefined, type))
            : (rows as T[]);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rawFindUnsafe<T>(sqlIn: string, bindings: any[], existingSession?: DatabaseSession<any>, type?: ReceiveType<T>): Promise<T[]> {
        return this.rawFind<T>(this.createSqlQuery(sqlIn, bindings), existingSession, type);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rawFindOne<T>(sqlIn: SqlQuery | string, existingSession?: DatabaseSession<any>, type?: ReceiveType<T>): Promise<T | undefined> {
        const rows = await this.rawFind<T>(sqlIn, existingSession, type);
        return rows[0];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rawFindOneUnsafe<T>(sqlIn: string, bindings: any[], existingSession?: DatabaseSession<any>, type?: ReceiveType<T>): Promise<T | undefined> {
        return this.rawFindOne<T>(this.createSqlQuery(sqlIn, bindings), existingSession, type);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSqlQuery(sqlIn: string, bindings: any[]): SqlQuery {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlPieces: TemplateStringsArray = sqlIn.split('?') as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sqlPieces as any).raw = sqlIn;
        return sql(sqlPieces, ...bindings);
    }
}

type FieldsMatching<T, V> = {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    [K in keyof T]: T[K] extends V ? (T[K] extends Function ? never : K) : never;
}[keyof T];
export type DataTypes = string | number | boolean | Date | object | null;
export type EntityFieldKeys<T extends object> = FieldsMatching<T, DataTypes>;
export type EntityFields<T extends object> = Pick<T, EntityFieldKeys<T>>; // https://github.com/deepkit/deepkit-framework/issues/430
export type EntityClassFields<T extends ClassType> = Pick<InstanceType<T>, EntityFieldKeys<InstanceType<T>>>;

export declare type HasDefault = TypeAnnotation<'dksf:hasDefault'>;
export type OptionalKeys<T extends object> = ObjectKeysMatching<T, HasDefault> | ObjectKeysMatching<T, null> | ObjectKeysMatching<T, AutoIncrement>;
export type EntityOptionals<T extends object> = { [K in keyof Pick<T, OptionalKeys<T>>]?: T[K] } & { [K in keyof Omit<T, OptionalKeys<T>>]: T[K] };
export type NewEntityFields<T extends object> = EntityOptionals<EntityFields<T>>;

export function createEntity<D extends T, T extends ActiveRecord = ActiveRecord>(Entity: ClassType<T>, data: NewEntityFields<D>): T {
    const entity = new Entity();
    Object.assign(entity, data);

    // fill in the nulls and auto-increments
    const type = ReflectionClass.from(Entity);
    for (const property of type.getProperties()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((data as any)[property.name] === undefined) {
            if (property.isAutoIncrement()) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (entity as any)[property.name] = 0;
            } else if (property.isNullable()) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (entity as any)[property.name] = null;
            }
        }
    }

    return entity;
}

export function createEntities<D extends T, T extends ActiveRecord = ActiveRecord>(Entity: ClassType<T>, data: NewEntityFields<D>[]): T[] {
    return data.map(d => createEntity(Entity, d));
}

export function createQueuedEntity<D extends T, T extends ActiveRecord = ActiveRecord>(
    Entity: ClassType<T>,
    data: NewEntityFields<D>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session: DatabaseSession<any>
): T {
    const entity = createEntity(Entity, data);
    session.add(entity);
    return entity;
}

export function createQueuedEntities<D extends T, T extends ActiveRecord = ActiveRecord>(
    Entity: ClassType<T>,
    data: NewEntityFields<D>[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session: DatabaseSession<any>
): T[] {
    const entities = createEntities(Entity, data);
    session.add(...entities);
    return entities;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function persistEntity<T extends ActiveRecord>(entity: T, session?: DatabaseSession<any>) {
    return persistEntities([entity], session);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function persistEntities<T extends ActiveRecord>(entities: T[], session?: DatabaseSession<any>) {
    if (session) {
        session.add(...entities);
        await session.flush();
    } else {
        for (const entity of entities) {
            await entity.save();
        }
    }
}

export async function createPersistedEntity<D extends T, T extends ActiveRecord = ActiveRecord>(
    Entity: ClassType<T>,
    data: NewEntityFields<D>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session?: DatabaseSession<any>
): Promise<T> {
    const entity = createEntity(Entity, data);
    await persistEntity(entity, session);
    return entity;
}

export async function createPersistedEntities<D extends T, T extends ActiveRecord = ActiveRecord>(
    Entity: ClassType<T>,
    data: NewEntityFields<D>[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session?: DatabaseSession<any>
): Promise<T[]> {
    const entities = createEntities(Entity, data);
    await persistEntities(entities, session);
    return entities;
}

const PKFieldCache = new WeakMap<ActiveRecordClassType, string>();
export function getPKFieldForEntity(EntityClass: ActiveRecordClassType) {
    if (PKFieldCache.has(EntityClass)) return PKFieldCache.get(EntityClass)!;
    const pkField = ReflectionClass.from(EntityClass).getPrimary().name;
    PKFieldCache.set(EntityClass, pkField);
    return pkField;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPKFieldForEntityInstance(entity: any) {
    if (!(entity instanceof ActiveRecord)) {
        if (typeof entity === 'object' && 'id' in entity) return 'id';
        throw new Error('Entity does not extend ActiveRecord class and does not have "id" field');
    }
    return getPKFieldForEntity(entity.constructor as ActiveRecordClassType);
}

type EntityFilter<T extends ActiveRecordClassType> = FilterQuery<InstanceType<T>> | string | number;

function getEntityFilter<T extends ActiveRecordClassType>(EntityClass: T, filter: EntityFilter<T>): FilterQuery<InstanceType<T>> {
    if (typeof filter === 'object') return filter;
    const pkField = getPKFieldForEntity(EntityClass);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { [pkField]: filter } as any;
}

export async function getEntityOrUndefined<T extends ActiveRecordClassType>(
    EntityClass: T,
    filter: EntityFilter<T>
): Promise<InstanceType<T> | undefined> {
    const query: SQLDatabaseQuery<InstanceType<T>> = EntityClass.query();
    const resolvedFilter = getEntityFilter(EntityClass, filter);
    return query.filter(resolvedFilter).findOneOrUndefined();
}

export async function getEntityOr404<T extends ActiveRecordClassType>(EntityClass: T, filter: EntityFilter<T>): Promise<InstanceType<T>> {
    const entity = await getEntityOrUndefined(EntityClass, filter);
    if (!entity) throw new HttpNotFoundError();
    return entity;
}

export async function getEntity<T extends ActiveRecordClassType>(EntityClass: T, filter: EntityFilter<T>): Promise<InstanceType<T>> {
    const entity = await getEntityOrUndefined(EntityClass, filter);
    if (!entity) throw new ItemNotFound();
    return entity;
}

export async function entityExists<T extends ActiveRecordClassType>(EntityClass: T, filter: EntityFilter<T>): Promise<boolean> {
    const query: SQLDatabaseQuery<InstanceType<T>> = EntityClass.query();
    const resolvedFilter = getEntityFilter(EntityClass, filter);
    return query.filter(resolvedFilter).has();
}

export function getEntityFields<T extends ActiveRecord>(entity: T): EntityFields<T> {
    return pick(entity, Object.keys(entity)) as EntityFields<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logSql(sql: string, bindings: any[] = []) {
    const logBindings = [...bindings];
    console.log(sql.replace(/\?/g, () => JSON.stringify(logBindings.shift())));
}
