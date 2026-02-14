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
import { TestingHelpers, makeMockRequest } from '@signal24/dk-server-foundation';

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
        const res = await makeMockRequest(tf, 'GET', '/api/users/1', {});
        assert.strictEqual(res.statusCode, 200);
    });
});
```

### `createTestingFacade(appOptions, facadeOptions?)`

Creates a `TestingFacade` instance. The first argument is app options (same as `CreateAppOptions` but with `config` optional -- defaults to `BaseAppConfig`). The facade calls `createApp()` internally with `port: 0`.

### `ITestingFacadeOptions`

| Option               | Type                        | Default                        | Description                                                     |
| -------------------- | --------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `enableDatabase`     | `boolean`                   | `false`                        | Create an isolated test database                                |
| `enableMigrations`   | `boolean`                   | `true` (when database enabled) | Run migrations after database creation. Set to `false` to skip. |
| `autoSeedData`       | `boolean`                   | `false`                        | Run `seedData` automatically before each test                   |
| `databasePrefix`     | `string`                    | `'test'`                       | Prefix for test database names                                  |
| `onBeforeStart`      | `(facade) => Promise<void>` | —                              | Hook before app starts                                          |
| `onStart`            | `(facade) => Promise<void>` | —                              | Hook after app starts                                           |
| `onBeforeStop`       | `(facade) => Promise<void>` | —                              | Hook before app stops                                           |
| `onStop`             | `(facade) => Promise<void>` | —                              | Hook after app stops                                            |
| `seedData`           | `(facade) => Promise<void>` | —                              | Seed test data                                                  |
| `defaultTestHeaders` | `Record<string, string>`    | —                              | Default headers for mock requests                               |

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

### Database Isolation

Each test process gets its own database: `{prefix}_{timestamp}_{pid}_1`. Databases are created on `start()` and dropped on `stop()`.

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
import { TestingHelpers } from '@signal24/dk-server-foundation';

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

```typescript
import { makeMockRequest } from '@signal24/dk-server-foundation';

// Without custom headers
const res = await makeMockRequest(tf, 'GET', '/api/users', {});

// With custom headers
const res = await makeMockRequest(
    tf,
    'POST',
    '/api/users',
    {
        Authorization: 'Bearer token123',
        'Content-Type': 'application/json'
    },
    { name: 'Alice', email: 'alice@example.com' }
);

// Response
assert.strictEqual(res.statusCode, 200);
assert.deepStrictEqual(res.json, { id: 1, name: 'Alice' });
```

Methods: `GET`, `PUT`, `POST`, `DELETE`.

Default headers from `options.defaultTestHeaders` are merged with per-request headers.

## SQL Mocking

Mock database queries without a real database:

```typescript
import { SqlTestingHelper } from '@signal24/dk-server-foundation';

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

## Configuration

For tests without a database, set `MYSQL_MIN_IDLE_CONNECTIONS=0` to avoid connection attempts.

## Redis Cleanup

If your tests use Redis-backed features, call `disconnectAllRedis()` in your `after()` hook:

```typescript
import { after } from 'node:test';
import { disconnectAllRedis } from '@signal24/dk-server-foundation';

after(async () => {
    await tf.stop();
    await disconnectAllRedis();
});
```
