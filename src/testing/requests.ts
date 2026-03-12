import { HttpRequest, MemoryHttpResponse } from '@deepkit/http';
import { MySQLConnectionPool, MySQLDatabaseAdapter } from '@deepkit/mysql';
import { PostgresConnectionPool, PostgresDatabaseAdapter } from '@deepkit/postgres';
import { mock, before, after, beforeEach, afterEach } from 'node:test';

import { TestingFacade } from '.';

function installDbRejectionHooks() {
    mock.method(MySQLConnectionPool.prototype, 'getConnection', () => {
        throw new Error('Database is not enabled in testing mode');
    });
    mock.method(MySQLDatabaseAdapter.prototype, 'disconnect', () => {});

    mock.method(PostgresConnectionPool.prototype, 'getConnection', () => {
        throw new Error('Database is not enabled in testing mode');
    });
    mock.method(PostgresDatabaseAdapter.prototype, 'disconnect', () => {});
}

export function installStandardHooks(tf: TestingFacade) {
    before(() => tf.start());
    after(() => tf.stop());

    if (!tf.options?.enableDatabase) {
        beforeEach(() => installDbRejectionHooks());
        afterEach(() => tf.sql.clearMocks());
    }

    beforeEach(() => tf.resetToSeed());
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });
}

export function resetSrcModuleCache() {
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/dist/') || key.includes('/src/')) {
            delete require.cache[key];
        }
    }
}

type MockMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockBody = Record<string, any>;
export async function makeMockRequest(tf: TestingFacade, method: MockMethod, url: string, body: MockBody): Promise<MemoryHttpResponse>;
export async function makeMockRequest(
    tf: TestingFacade,
    method: MockMethod,
    url: string,
    headers: Record<string, string>,
    body: MockBody
): Promise<MemoryHttpResponse>;
export async function makeMockRequest(
    tf: TestingFacade,
    method: MockMethod,
    url: string,
    headersOrBody: Record<string, string> | MockBody,
    body?: MockBody
): Promise<MemoryHttpResponse> {
    const headers = body ? headersOrBody : tf.options?.defaultTestHeaders;
    return tf.request(
        HttpRequest[method](url)
            .headers({ 'content-type': 'application/json', ...headers })
            .body(JSON.stringify(body ?? headersOrBody))
    );
}
