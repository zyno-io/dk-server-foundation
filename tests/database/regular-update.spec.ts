import { DatabasePersistenceChangeSet } from '@deepkit/orm';
import { getPreparedEntity, SQLConnection } from '@deepkit/sql';
import { AutoIncrement, entity, ItemChanges, PrimaryKey, ReflectionClass } from '@deepkit/type';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MySQLDatabaseAdapter } from '../../src/database/mysql';
import { PostgresDatabaseAdapter } from '../../src/database/postgres';
import { batchUpdateWithRegularUpdateStatements } from '../../src/database/regular-update';

@entity.name('regular_update_entity')
class RegularUpdateEntity {
    id!: number & AutoIncrement & PrimaryKey;
    name!: string;
    count!: number;
}

interface RecordedStatement {
    sql: string;
    params: unknown[];
}

function createChangeSet(): DatabasePersistenceChangeSet<RegularUpdateEntity> {
    return createSetOnlyChangeSet(1, 'updated');
}

function createSetOnlyChangeSet(id: number, name: string): DatabasePersistenceChangeSet<RegularUpdateEntity> {
    const item = { id, name: 'original', count: 10 };
    const changes = new ItemChanges<RegularUpdateEntity>(undefined, item);
    changes.set('name', name);

    return {
        changes,
        item,
        primaryKey: { id }
    };
}

function createNamedChangeSet(id: number, name: string): DatabasePersistenceChangeSet<RegularUpdateEntity> {
    const item = { id, name: 'original', count: 10 };
    const changes = new ItemChanges<RegularUpdateEntity>(undefined, item);
    changes.set('name', name);
    changes.increase('count', 2);

    return {
        changes,
        item,
        primaryKey: { id }
    };
}

function createRecordingConnection(statements: RecordedStatement[], failUpdateAt?: number): SQLConnection {
    let updateCount = 0;

    return {
        run: async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            if (/^\s*UPDATE\b/i.test(sql)) {
                updateCount++;
                if (updateCount === failUpdateAt) throw new Error('update failed');
            }
        },
        execAndReturnSingle: async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            return { count: 12 };
        }
    } as SQLConnection;
}

describe('regular Deepkit update patch', () => {
    it('uses regular UPDATE statements without a temporary transaction for MySQL set-only updates', async () => {
        const adapter = new MySQLDatabaseAdapter({});
        const entity = getPreparedEntity(adapter, ReflectionClass.from(RegularUpdateEntity));
        const statements: RecordedStatement[] = [];
        const connection = createRecordingConnection(statements);

        try {
            await batchUpdateWithRegularUpdateStatements(
                {
                    platform: adapter.platform,
                    getConnection: async () => connection,
                    hasActiveTransaction: () => false,
                    handleSpecificError: error => error
                },
                entity,
                [createChangeSet()]
            );
        } finally {
            adapter.disconnect();
        }

        assert.equal(statements.length, 1);
        assert.doesNotMatch(statements[0].sql, /\bWITH\b/i);
        assert.match(statements[0].sql, /UPDATE `regular_update_entity`/);
        assert.match(statements[0].sql, /SET `name` = \?/);
        assert.match(statements[0].sql, /WHERE `id` = \?/);
        assert.deepEqual(statements[0].params, ['updated', 1]);
        assert.equal(
            statements.some(statement => /^\s*START TRANSACTION\b/i.test(statement.sql)),
            false
        );
    });

    it('uses regular UPDATE statements without a temporary transaction for PostgreSQL set-only updates', async () => {
        const adapter = new PostgresDatabaseAdapter({});
        const entity = getPreparedEntity(adapter, ReflectionClass.from(RegularUpdateEntity));
        const statements: RecordedStatement[] = [];
        const connection = createRecordingConnection(statements);

        try {
            await batchUpdateWithRegularUpdateStatements(
                {
                    platform: adapter.platform,
                    getConnection: async () => connection,
                    hasActiveTransaction: () => false,
                    handleSpecificError: error => error
                },
                entity,
                [createChangeSet()]
            );
        } finally {
            adapter.disconnect();
        }

        assert.equal(statements.length, 1);
        assert.doesNotMatch(statements[0].sql, /\bWITH\b/i);
        assert.match(statements[0].sql, /UPDATE "regular_update_entity"/);
        assert.match(statements[0].sql, /SET "name" = \$1(?:::text)?/);
        assert.match(statements[0].sql, /WHERE "id" = \$2(?:::integer)?/);
        assert.deepEqual(statements[0].params, ['updated', 1]);
        assert.equal(
            statements.some(statement => /^\s*START TRANSACTION\b/i.test(statement.sql)),
            false
        );
    });

    it('wraps a single-row increment in a temporary transaction for readback', async () => {
        const adapter = new MySQLDatabaseAdapter({});
        const entity = getPreparedEntity(adapter, ReflectionClass.from(RegularUpdateEntity));
        const statements: RecordedStatement[] = [];
        const connection = createRecordingConnection(statements);
        let connectionRequests = 0;

        try {
            await batchUpdateWithRegularUpdateStatements(
                {
                    platform: adapter.platform,
                    getConnection: async () => {
                        connectionRequests++;
                        return connection;
                    },
                    hasActiveTransaction: () => false,
                    handleSpecificError: error => error
                },
                entity,
                [createNamedChangeSet(1, 'incremented')]
            );
        } finally {
            adapter.disconnect();
        }

        assert.equal(connectionRequests, 1);
        assert.deepEqual(
            statements
                .filter(statement => /^\s*(START TRANSACTION|UPDATE|SELECT|COMMIT)\b/i.test(statement.sql))
                .map(statement => statement.sql.trim().split(/\s+/)[0].toUpperCase()),
            ['START', 'UPDATE', 'SELECT', 'COMMIT']
        );
    });

    it('wraps multi-row updates in a temporary transaction on the update connection when no session transaction is active', async () => {
        const adapter = new MySQLDatabaseAdapter({});
        const entity = getPreparedEntity(adapter, ReflectionClass.from(RegularUpdateEntity));
        const statements: RecordedStatement[] = [];
        const connection = createRecordingConnection(statements);
        let connectionRequests = 0;

        try {
            await batchUpdateWithRegularUpdateStatements(
                {
                    platform: adapter.platform,
                    getConnection: async () => {
                        connectionRequests++;
                        return connection;
                    },
                    hasActiveTransaction: () => false,
                    handleSpecificError: error => error
                },
                entity,
                [createNamedChangeSet(1, 'first'), createNamedChangeSet(2, 'second')]
            );
        } finally {
            adapter.disconnect();
        }

        assert.equal(connectionRequests, 1);
        assert.deepEqual(
            statements
                .filter(statement => /^\s*(START TRANSACTION|UPDATE|SELECT|COMMIT)\b/i.test(statement.sql))
                .map(statement => statement.sql.trim().split(/\s+/)[0].toUpperCase()),
            ['START', 'UPDATE', 'SELECT', 'UPDATE', 'SELECT', 'COMMIT']
        );
        assert.equal(statements.filter(statement => /^\s*UPDATE\b/i.test(statement.sql)).length, 2);
    });

    it('uses the existing session transaction instead of creating a temporary transaction', async () => {
        const adapter = new MySQLDatabaseAdapter({});
        const entity = getPreparedEntity(adapter, ReflectionClass.from(RegularUpdateEntity));
        const statements: RecordedStatement[] = [];
        const connection = createRecordingConnection(statements);
        let connectionRequests = 0;

        try {
            await batchUpdateWithRegularUpdateStatements(
                {
                    platform: adapter.platform,
                    getConnection: async () => {
                        connectionRequests++;
                        return connection;
                    },
                    hasActiveTransaction: () => true,
                    handleSpecificError: error => error
                },
                entity,
                [createNamedChangeSet(1, 'first'), createNamedChangeSet(2, 'second')]
            );
        } finally {
            adapter.disconnect();
        }

        assert.equal(connectionRequests, 1);
        assert.equal(
            statements.some(statement => /^\s*START TRANSACTION\b/i.test(statement.sql)),
            false
        );
        assert.equal(statements.filter(statement => /^\s*UPDATE\b/i.test(statement.sql)).length, 2);
    });

    it('rolls back a temporary transaction when a later row update fails', async () => {
        const adapter = new MySQLDatabaseAdapter({});
        const entity = getPreparedEntity(adapter, ReflectionClass.from(RegularUpdateEntity));
        const statements: RecordedStatement[] = [];
        const connection = createRecordingConnection(statements, 2);

        try {
            await assert.rejects(
                batchUpdateWithRegularUpdateStatements(
                    {
                        platform: adapter.platform,
                        getConnection: async () => connection,
                        hasActiveTransaction: () => false,
                        handleSpecificError: error => error
                    },
                    entity,
                    [createNamedChangeSet(1, 'first'), createNamedChangeSet(2, 'second')]
                ),
                { name: 'DatabaseUpdateError' }
            );
        } finally {
            adapter.disconnect();
        }

        assert.deepEqual(
            statements
                .filter(statement => /^\s*(START TRANSACTION|UPDATE|SELECT|ROLLBACK)\b/i.test(statement.sql))
                .map(statement => statement.sql.trim().split(/\s+/)[0].toUpperCase()),
            ['START', 'UPDATE', 'SELECT', 'UPDATE', 'ROLLBACK']
        );
        assert.equal(statements.filter(statement => /^\s*UPDATE\b/i.test(statement.sql)).length, 2);
    });
});
