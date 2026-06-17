import { DatabasePersistenceChangeSet, DatabaseUpdateError, OrmEntity } from '@deepkit/orm';
import { DefaultPlatform, PreparedEntity, SQLConnection } from '@deepkit/sql';
import { getPartialSerializeFunction, ReflectionClass } from '@deepkit/type';

interface RegularUpdateContext {
    platform: DefaultPlatform;
    getConnection: () => Promise<SQLConnection>;
    hasActiveTransaction: () => boolean;
    handleSpecificError: (error: Error) => Error;
}

const hasOwn = (obj: object | undefined, key: string): boolean => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

export async function batchUpdateWithRegularUpdateStatements<T extends OrmEntity>(
    context: RegularUpdateContext,
    entity: PreparedEntity,
    changeSets: DatabasePersistenceChangeSet<T>[]
): Promise<void> {
    const partialSerialize = getPartialSerializeFunction(entity.type, context.platform.serializer.serializeRegistry);

    try {
        if (!context.hasActiveTransaction() && shouldUseTemporaryTransaction(changeSets)) {
            await runInTemporaryTransaction(context, connection => executeUpdates(context, entity, changeSets, partialSerialize, connection));
            return;
        }

        await executeUpdates(context, entity, changeSets, partialSerialize, await context.getConnection());
    } catch (error) {
        const reflection = ReflectionClass.from(entity.type);
        const updateError = new DatabaseUpdateError(reflection, changeSets, `Could not update ${reflection.getClassName()} in database`, {
            cause: error
        });
        throw context.handleSpecificError(updateError);
    }
}

function shouldUseTemporaryTransaction<T extends OrmEntity>(changeSets: DatabasePersistenceChangeSet<T>[]): boolean {
    return changeSets.length > 1 || changeSets.some(changeSet => Object.keys(changeSet.changes.$inc ?? {}).length > 0);
}

async function runInTemporaryTransaction(context: RegularUpdateContext, callback: (connection: SQLConnection) => Promise<void>): Promise<void> {
    const connection = await context.getConnection();
    let transactionStarted = false;

    try {
        await connection.run('START TRANSACTION');
        transactionStarted = true;
        await callback(connection);
        await connection.run('COMMIT');
        transactionStarted = false;
    } catch (error) {
        if (transactionStarted) {
            try {
                await connection.run('ROLLBACK');
            } catch (rollbackError) {
                if (error instanceof Error) {
                    Object.defineProperty(error, 'rollbackError', { value: rollbackError, configurable: true });
                }
            }
        }

        throw error;
    }
}

async function executeUpdates<T extends OrmEntity>(
    context: RegularUpdateContext,
    entity: PreparedEntity,
    changeSets: DatabasePersistenceChangeSet<T>[],
    partialSerialize: (value: unknown) => unknown,
    connection: SQLConnection
): Promise<void> {
    for (const changeSet of changeSets) {
        const params: unknown[] = [];
        const set: string[] = [];
        const placeholder = new context.platform.placeholderStrategy();
        const serializedSet = changeSet.changes.$set ? (partialSerialize(changeSet.changes.$set) as Record<string, unknown>) : undefined;
        const increments = changeSet.changes.$inc as Record<string, unknown> | undefined;

        for (const fieldName of changeSet.changes.fieldNames) {
            const property = entity.fieldMap[fieldName];
            if (!property) throw new Error(`Unsupported update field "${fieldName}" on ${entity.name}.`);

            if (hasOwn(increments, fieldName)) {
                params.push(increments![fieldName]);
                set.push(`${property.columnNameEscaped} = ${property.columnNameEscaped} + ${property.sqlTypeCast(placeholder.getPlaceholder())}`);
            } else if (hasOwn(changeSet.changes.$unset, fieldName)) {
                set.push(`${property.columnNameEscaped} = NULL`);
            } else if (hasOwn(changeSet.changes.$set as object | undefined, fieldName)) {
                params.push(hasOwn(serializedSet, fieldName) ? serializedSet![fieldName] : null);
                set.push(`${property.columnNameEscaped} = ${property.sqlTypeCast(placeholder.getPlaceholder())}`);
            }
        }

        if (!set.length) continue;

        const serializedPk = partialSerialize(changeSet.primaryKey) as Record<string, unknown>;
        params.push(serializedPk[entity.primaryKey.name]);

        await connection.run(
            `UPDATE ${entity.tableNameEscaped}
             SET ${set.join(', ')}
             WHERE ${entity.primaryKey.columnNameEscaped} = ${entity.primaryKey.sqlTypeCast(placeholder.getPlaceholder())}`,
            params
        );

        const returningFields = Object.keys(changeSet.changes.$inc ?? {});
        if (returningFields.length) {
            await assignReturningFields(context, connection, entity, changeSet, returningFields);
        }
    }
}

async function assignReturningFields<T extends OrmEntity>(
    context: RegularUpdateContext,
    connection: SQLConnection,
    entity: PreparedEntity,
    changeSet: DatabasePersistenceChangeSet<T>,
    returningFields: string[]
) {
    const placeholder = new context.platform.placeholderStrategy();
    const serializedItem = partialSerializeItem(context, entity, changeSet.item);
    const params = [serializedItem[entity.primaryKey.name]];
    const select = returningFields.map(fieldName => {
        const property = entity.fieldMap[fieldName];
        if (!property) throw new Error(`Unsupported returning field "${fieldName}" on ${entity.name}.`);

        return `${property.columnNameEscaped} AS ${context.platform.quoteIdentifier(fieldName)}`;
    });

    const row = await connection.execAndReturnSingle(
        `SELECT ${select.join(', ')}
         FROM ${entity.tableNameEscaped}
         WHERE ${entity.primaryKey.columnNameEscaped} = ${entity.primaryKey.sqlTypeCast(placeholder.getPlaceholder())}`,
        params
    );

    if (!row) return;

    for (const fieldName of returningFields) {
        changeSet.item[fieldName as keyof T] = row[fieldName];
    }
}

function partialSerializeItem<T extends OrmEntity>(context: RegularUpdateContext, entity: PreparedEntity, item: T): Record<string, unknown> {
    const partialSerialize = getPartialSerializeFunction(entity.type, context.platform.serializer.serializeRegistry);
    return partialSerialize(item) as Record<string, unknown>;
}
