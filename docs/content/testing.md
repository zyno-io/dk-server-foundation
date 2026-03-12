# Testing

Test facades with per-test database isolation, entity fixtures, request mocking, and SQL mocking.

## Setup

Tests use `node:test` runner against compiled output. The global setup enforces UTC timezone.

```bash
# Run all tests
yarn test

# Run a single test file
yarn test tests/helpers/array.spec.ts

# Run with debugger
yarn test:debug
```

## Testing Facade

`TestingFacade` wraps a Deepkit app for testing with database isolation and lifecycle hooks.

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestingHelpers } from '@zyno-io/dk-server-foundation';

// Pass app options (not an app instance) -- the facade creates the app for you
const tf = TestingHelpers.createTestingFacade(
    {
        db: MyDB,
        controllers: [UserController],
        providers: [UserService]
    },
    {
        enableDatabase: true,
        seedData: async facade => {
            await loadEntityFixtures([fixtures.user1, fixtures.admin1]);
        }
    }
);

TestingHelpers.installStandardHooks(tf);

describe('UserController', () => {
    it('should return user', async () => {
        const res = await TestingHelpers.makeMockRequest(tf, 'GET', '/api/users/1', {});
        assert.strictEqual(res.statusCode, 200);
    });
});
```

### `createTestingFacade(appOptions, facadeOptions?)`

Creates a `TestingFacade` instance. The first argument is app options (same as `CreateAppOptions` but with `config` optional -- defaults to `BaseAppConfig`). The facade calls `createApp()` internally with `port: 0`.

### `ITestingFacadeOptions`

| Option               | Type                        | Default                        | Description                                                      |
| -------------------- | --------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `enableDatabase`     | `boolean`                   | `false`                        | Create an isolated test database                                 |
| `dbAdapter`          | `'postgres' \| 'mysql'`     | —                              | Database adapter to use (required when `enableDatabase` is true) |
| `enableMigrations`   | `boolean`                   | `true` (when database enabled) | Run migrations after database creation. Set to `false` to skip.  |
| `autoSeedData`       | `boolean`                   | `false`                        | Run `seedData` automatically before each test                    |
| `databasePrefix`     | `string`                    | `'test'`                       | Prefix for test database names                                   |
| `onBeforeStart`      | `(facade) => Promise<void>` | —                              | Hook before app starts                                           |
| `onStart`            | `(facade) => Promise<void>` | —                              | Hook after app starts                                            |
| `onBeforeStop`       | `(facade) => Promise<void>` | —                              | Hook before app stops                                            |
| `onStop`             | `(facade) => Promise<void>` | —                              | Hook after app stops                                             |
| `seedData`           | `(facade) => Promise<void>` | —                              | Seed test data                                                   |
| `defaultTestHeaders` | `Record<string, string>`    | —                              | Default headers for mock requests                                |

### Facade Methods

| Method              | Description                                |
| ------------------- | ------------------------------------------ |
| `start()`           | Start the app and create the test database |
| `stop()`            | Stop the app and destroy the test database |
| `createDatabase()`  | Create the isolated test database          |
| `destroyDatabase()` | Drop the test database                     |
| `truncateTables()`  | Truncate all tables                        |
| `runMigrations()`   | Run pending migrations                     |
| `resetToSeed()`     | Truncate tables and re-seed                |

### Database Configuration

Use `setDefaultDatabaseConfig` to provide database credentials for tests. This sets environment variables as defaults (won't override existing env vars), so it works as a fallback when credentials aren't provided via the environment.

```typescript
// PostgreSQL
TestingHelpers.setDefaultDatabaseConfig({
    PG_HOST: 'localhost',
    PG_PORT: 5432,
    PG_USER: 'root',
    PG_PASSWORD_SECRET: 'secret'
});

// MySQL
TestingHelpers.setDefaultDatabaseConfig({
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: 3306,
    MYSQL_USER: 'root',
    MYSQL_PASSWORD_SECRET: 'secret'
});
```

Call this before creating any testing facades — typically at the top of a shared bootstrap/helper module that all test files import, or in a `globalSetup.ts` file (see [Global Setup](#global-setup)).

When using `enableDatabase: true`, you must also specify the `dbAdapter` option:

```typescript
const tf = TestingHelpers.createTestingFacade(appOptions, {
    enableDatabase: true,
    dbAdapter: 'postgres' // or 'mysql'
});
```

### Database Isolation

Each test process gets its own database: `{prefix}_{timestamp}_{pid}_1`. Databases are created on `start()` and dropped on `stop()`.

Use `cleanupTestDatabases(prefix)` to remove leftover test databases (e.g., from interrupted test runs):

```typescript
await TestingHelpers.cleanupTestDatabases('myapp_test');
```

Environment variables:

| Variable       | Description                       |
| -------------- | --------------------------------- |
| `TEST_KEEP_DB` | Skip database destruction on stop |

## Standard Hooks

`installStandardHooks(tf)` sets up test lifecycle hooks:

- `before` -- Start the facade
- `after` -- Stop the facade
- `beforeEach` -- Reset to seed data; install DB rejection hooks if database is disabled
- `afterEach` -- Reset timers, restore all mocks, clear SQL mocks

## Entity Fixtures

Define reusable test data with automatic date handling:

```typescript
import { TestingHelpers } from '@zyno-io/dk-server-foundation';

const { defineEntityFixtures, loadEntityFixtures } = TestingHelpers;

const fixtures = defineEntityFixtures(User, {
    alice: {
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        createdAt: '2024-01-01T00:00:00Z' // String dates auto-converted
    },
    bob: {
        id: 2,
        name: 'Bob',
        email: 'bob@example.com',
        createdAt: '2024-01-02T00:00:00Z'
    }
});

// Load into database
await loadEntityFixtures([fixtures.alice, fixtures.bob]);
```

### `defineEntityFixtures(entityClass, data)`

- Date fields accept ISO strings (converted to `Date` on load)
- Fields with defaults (auto-increment, nullable, `HasDefault`) are optional
- Returns an object with the same keys, each containing prepared fixture data

### `prepareEntityFixtures(entityClass, data)`

Lower-level function to prepare a single fixture record:

```typescript
const prepared = TestingHelpers.prepareEntityFixtures(User, {
    name: 'Charlie',
    email: 'charlie@example.com'
});
```

## Mock HTTP Requests

`makeMockRequest` sends requests through Deepkit's HTTP kernel in-memory — no real HTTP server or port needed. Requests are routed, validated, and handled exactly as they would be in production.

```typescript
// GET request (body is required but ignored — pass empty object)
const res = await TestingHelpers.makeMockRequest(tf, 'GET', '/api/users', {});

// POST request with JSON body
const res = await TestingHelpers.makeMockRequest(tf, 'POST', '/api/users', {
    name: 'Alice',
    email: 'alice@example.com'
});

// With custom headers (headers object goes before body)
const res = await TestingHelpers.makeMockRequest(
    tf,
    'POST',
    '/api/users',
    { Authorization: 'Bearer token123' },
    { name: 'Alice', email: 'alice@example.com' }
);
```

### Response

The response is a `MemoryHttpResponse` with:

| Property     | Type     | Description                          |
| ------------ | -------- | ------------------------------------ |
| `statusCode` | `number` | HTTP status code                     |
| `json`       | `any`    | Parsed JSON body (throws on invalid) |
| `text`       | `string` | Raw body as string                   |
| `body`       | `Buffer` | Raw body buffer                      |
| `headers`    | `object` | Response headers                     |

```typescript
assert.strictEqual(res.statusCode, 200);
assert.deepStrictEqual(res.json, { id: 1, name: 'Alice' });
```

### Signatures

```typescript
// Without custom headers — uses defaultTestHeaders from facade options
makeMockRequest(tf, method, url, body): Promise<MemoryHttpResponse>

// With custom headers — merged with defaultTestHeaders
makeMockRequest(tf, method, url, headers, body): Promise<MemoryHttpResponse>
```

Methods: `GET`, `PUT`, `POST`, `DELETE`.

### Limitations

Mock requests always send JSON (`content-type: application/json`). Endpoints that require multipart form data (e.g., `UploadedFile` parameters) cannot be tested via `makeMockRequest`. For file upload endpoints, use `tf.request()` directly with a Deepkit `HttpRequest`.

## SQL Mocking

Mock database queries without a real database:

```typescript
import { SqlTestingHelper } from '@zyno-io/dk-server-foundation';

const sql = new SqlTestingHelper();

// Mock entity data
sql.mockEntity(User, [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' }
]);

// Queries against User will return mocked data
const users = await db.query(User).find();
// [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]

// Throws if no mock is set up
// "No mock data found for entity: User"

// Clear all mocks
sql.clearMocks();
```

Uses Deepkit's `MemoryDatabaseAdapter` internally. Automatically cleared by `installStandardHooks`.

## Assertion Helpers

dk-server-foundation provides assertion helpers that complement `node:assert`:

### `matchesObject`

Partial matching (like Jest's `toMatchObject`):

```typescript
import { matchesObject } from '@zyno-io/dk-server-foundation/testing/expect';

matchesObject(result, { name: 'Fred', age: 30 });
```

### Asymmetric Matchers

Use with `matchesObject` for flexible matching:

```typescript
import { matchesObject, anyOf, stringContaining, arrayContaining, anything, objectContaining } from '@zyno-io/dk-server-foundation/testing/expect';

matchesObject(result, {
    id: anyOf(Number),
    name: stringContaining('Fred'),
    tags: arrayContaining(['admin']),
    metadata: objectContaining({ source: 'api' }),
    updatedAt: anything()
});
```

### `assertCalledWith`

Assert mock function calls with matcher support:

```typescript
import { assertCalledWith, anyOf } from '@zyno-io/dk-server-foundation/testing/expect';

assertCalledWith(mockFn, 'arg1', anyOf(Number));
```

## Module Mocking

Since tests run against CJS output, use `resetSrcModuleCache()` to clear cached modules before patching:

```typescript
import { TestingHelpers } from '@zyno-io/dk-server-foundation';

TestingHelpers.resetSrcModuleCache();
const resolver = require('../../src/app/resolver');
resolver.getAppConfig = () => mockConfig;
const { MyModule } = require('../../src/my-module');
```

This works because CJS `import { x } from 'y'` compiles to `const y_1 = require('y')`, preserving a reference to the module exports object. Patching a property on the exports object is visible to all subsequently-required modules.

## Global Setup

`dksf-test` automatically loads `dist/tests/shared/globalSetup.js` if it exists, calling `setup()` before tests and `teardown()` after:

```typescript
// tests/shared/globalSetup.ts
import { TestingHelpers } from '@zyno-io/dk-server-foundation';

export async function setup() {
    TestingHelpers.setDefaultDatabaseConfig({
        PG_HOST: 'localhost',
        PG_PORT: 5432,
        PG_USER: 'root',
        PG_PASSWORD_SECRET: 'secret'
    });

    await TestingHelpers.cleanupTestDatabases('myapp_test');
}

export async function teardown() {
    await TestingHelpers.cleanupTestDatabases('myapp_test');
}
```

## Configuration

For tests without a database, set `MYSQL_MIN_IDLE_CONNECTIONS=0` to avoid connection attempts.

The `isTest` constant checks `process.env.APP_ENV === 'test'`. The `dksf-test` runner sets `APP_ENV=test` and `TZ=UTC` automatically.

## Redis Cleanup

If your tests use Redis-backed features, call `disconnectAllRedis()` in your `after()` hook:

```typescript
import { after } from 'node:test';
import { disconnectAllRedis } from '@zyno-io/dk-server-foundation';

after(async () => {
    await tf.stop();
    await disconnectAllRedis();
});
```
