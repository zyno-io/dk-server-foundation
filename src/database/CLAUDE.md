# Database Layer

This directory provides MySQL and PostgreSQL database abstractions built on Deepkit ORM with additional features for transactions, locking, and entity management.

## Core Components

### BaseDatabase (common.ts)

The foundation class that all database instances should extend. Key features:

**Transaction Hooks**

```typescript
await db.transaction(async txn => {
    // Pre-commit hooks run after txn.flush() but before commit
    txn.addPreCommitHook(async () => {
        // e.g., validate data, trigger side effects
    });

    // Post-commit hooks run after successful commit
    txn.addPostCommitHook(async () => {
        // e.g., send notifications, queue jobs
    });

    // Do work
    const entity = createQueuedEntity(MyEntity, { field: 'value' }, txn);
});
```

**Session-Level Locks**

```typescript
await db.transaction(async txn => {
    // Acquire row-level lock for the duration of the transaction
    await txn.acquireSessionLock('user:123');
    await txn.acquireSessionLock(['resource', 'type', id]);

    // Lock is held until commit/rollback
    const user = await txn.query(User).filter({ id: 123 }).findOne();
    user.balance -= 100;
});
```

On MySQL, the lock system uses a `_locks` table with row-level locking to prevent concurrent modifications (more flexible than MySQL's `GET_LOCK()` function). On PostgreSQL, it uses `pg_advisory_xact_lock` for transaction-scoped advisory locks.

**Raw Query Helpers**

```typescript
// Execute raw SQL
await db.rawExecute(sql`UPDATE users SET active = ${true} WHERE id = ${userId}`);

// Query and get results
const rows = await db.rawFind<User>(
    sql`SELECT * FROM users WHERE active = ${true}`,
    session, // optional
    typeOf<User>() // optional type for deserialization
);

// Query and get single result
const user = await db.rawFindOne<User>(sql`SELECT * FROM users WHERE id = ${id}`);

// Unsafe versions with string interpolation (be careful!)
await db.rawExecuteUnsafe('UPDATE users SET active = ? WHERE id = ?', [true, userId]);
```

**Session and Transaction Management**

```typescript
// Wrap work in transaction
await db.withTransaction(existingSession, async session => {
    // If existingSession is provided, reuses it
    // Otherwise creates new transaction
});

// Wrap work in session (no transaction)
await db.withSession(existingSession, async session => {
    // Useful for batch operations
});
```

### MySQLDatabaseAdapter (mysql.ts)

Custom Deepkit adapter with type transformations:

**Coordinate Type (POINT)** _(MySQL-only)_

```typescript
import { Coordinate } from './database';

@entity.name('location')
class Location {
    @entity.column
    position!: Coordinate; // Maps to MySQL POINT type
}

// Usage
const loc = new Location();
loc.position = { x: -122.4194, y: 37.7749 }; // San Francisco
await loc.save();
```

**DateString Type**

```typescript
import { DateString } from './types';

@entity.name('event')
class Event {
    @entity.column
    date!: DateString; // Stores as DATE (not DATETIME)
}

// Usage
event.date = new Date('2024-01-15'); // Stored as '2024-01-15'
```

**Test Date Mocking**
Both adapters include special handling in test environments (`process.env.APP_ENV === 'test'`), allowing date mocking to work correctly with Deepkit's type system.

### PostgresDatabaseAdapter (postgres.ts)

Custom Deepkit adapter with type transformations for `any`, `DateString`, and test date mocking. Same as MySQL adapter but without Coordinate/POINT support. Uses `pg_advisory_xact_lock` for session locks instead of the `_locks` table.

### Dialect Helpers (dialect.ts)

Centralizes dialect-specific SQL fragments:

- `getDialect(adapter)` — returns `'mysql'` or `'postgres'`
- `quoteId(dialect, name)` — backticks for MySQL, double-quotes for PostgreSQL
- `tableExistsSql()`, `listTablesSql()`, `listDatabasesSql()`, `currentDatabaseSql()`

### Creating a Database

```typescript
import { createMySQLDatabase, createPostgresDatabase } from './database';
import { User, Post, Comment } from './entities';

// MySQL
class MyDatabase extends createMySQLDatabase(
    {
        // Additional PoolConfig options (mariadb)
        connectionLimit: 20,
        minimumIdle: 5
    },
    [User, Post, Comment] // Entity classes
) {}

// MySQL reads config from BaseAppConfig:
// - MYSQL_HOST, MYSQL_PORT, MYSQL_USER
// - MYSQL_PASSWORD_SECRET, MYSQL_DATABASE
// - MYSQL_CONNECTION_LIMIT, MYSQL_MIN_IDLE_CONNECTIONS
// - MYSQL_IDLE_TIMEOUT_SECONDS

// PostgreSQL
class MyDatabase extends createPostgresDatabase(
    {
        // Additional PoolConfig options (pg)
        max: 20
    },
    [User, Post, Comment]
) {}

// PostgreSQL reads config from BaseAppConfig:
// - PG_HOST, PG_PORT, PG_USER
// - PG_PASSWORD_SECRET, PG_DATABASE, PG_SCHEMA
// - PG_CONNECTION_LIMIT, PG_IDLE_TIMEOUT_SECONDS
```

### Multi-Dialect Schema Builder: `db.schema`

Located in `src/database/schema/`. A Laravel-style fluent schema builder that emits dialect-appropriate SQL at runtime so a single migration file can target both MySQL and PostgreSQL.

**Architecture:**

- `Grammar` (abstract) + `MySQLGrammar` / `PostgresGrammar` — render canonical `ColumnSchema` / `IndexSchema` / `ForeignKeySchema` / `TableSchema` (from `migration/create/schema-model.ts`) into dialect-specific SQL. They own the *only* place SQL is emitted.
- `Blueprint` — per-table collector. Each `t.string(...)`, `t.foreign(...)`, etc. records intent against the canonical model. Knows the dialect via the Grammar to translate logical types like `t.boolean()`, `t.dateTime()`, `t.jsonb()`, `t.uuid()` to the right canonical type per dialect.
- `ColumnDefinition` / `ForeignKeyBuilder` — fluent modifiers (`.nullable()`, `.references()`, etc.).
- `Schema` — the `db.schema` entry point. Owns the per-migration FK deferral queue and PG enum-type dedup registry. Auto-flushed by the migration runner.

**Statement ordering** within a migration: PG enum types (deduped) → `CREATE TABLE` → `CREATE INDEX` per table → `ALTER TABLE ADD CONSTRAINT FOREIGN KEY` (deferred until `flush()`). Matches the ordering of the existing `migration/create/ddl-generator.ts` for backwards compatibility.

**Wiring:** `BaseDatabase.schema` is a lazy getter that picks the Grammar from `getDialect(adapter)` and reads `PG_SCHEMA` from app config. Uses `require()` instead of top-level import to break the `Schema → BaseDatabase` cycle.

**`migration:reset` is built on this builder.** `MigrationResetCommand` reads entity schema, then uses `builder-regenerator.ts` to emit a builder-based migration source file (rather than raw SQL). The regenerator is the inverse of the Blueprint — `TableSchema` → fluent builder source.

**`migration:create` defaults to builder output too.** Same regenerator, but consuming `SchemaDiff` via `generateBuilderMigrationFromDiff(diff)`. The legacy `--raw` flag falls back to the SQL emitter (`ddl-generator.ts`) for one-off scripts. Both code paths now share the same Grammar — `ddl-generator.ts` delegates every emit (`createTable`, `createIndex`, `addForeignKey`, `createEnumType`, `mysqlColumnDef`, `pgColumnDef`, `q`/`qTable`/`qType`) to MySQLGrammar/PostgresGrammar via thin wrappers.

**Schema introspection** (`db.schema.hasTable / hasColumn / hasIndex`) lets migrations be idempotent. Implementation queries `information_schema` (MySQL) or `pg_indexes` (PG). See `Schema.ts`.

### Dialect-Agnostic Factory: `createDatabase()`

`createDatabase()` (factory.ts) wraps the two dialect-specific factories so the dialect can be chosen via the `DB_ADAPTER` env var (or passed explicitly). Useful when the same image needs to target either backend.

```typescript
import { createDatabase } from './database';

// Shared form — reads DB_ADAPTER ('mysql' | 'postgres') from process.env at call time.
// Only `enableLocksTable` is accepted; pool tuning happens via MYSQL_* / PG_* env vars.
class AppDB extends createDatabase({ enableLocksTable: true }, [User, Post]) {}

// Explicit form — keeps each dialect's pool config typed.
class AppDB extends createDatabase('mysql', { connectionLimit: 20 }, [User]) {}
class AppDB extends createDatabase('postgres', { max: 20 }, [User]) {}
```

The shared form throws at call time if `DB_ADAPTER` is not set to `'mysql'` or `'postgres'`. It reads `process.env` directly (not `getAppConfig()`) because the database class must be defined at module load, before the app config is loaded — same pattern as `getTestDbAdapter()` in `src/testing/index.ts`. Both forms delegate to the existing `createMySQLDatabase` / `createPostgresDatabase`.

## Entity Management (entity.ts)

### Type-Safe Entity Creation

```typescript
import { createEntity, createPersistedEntity } from './database';

// Create entity without saving
const user = createEntity(User, {
    email: 'user@example.com',
    name: 'John'
    // id and createdAt are optional (AutoIncrement and nullable fields)
});

// Create and save immediately
const user = await createPersistedEntity(User, {
    email: 'user@example.com',
    name: 'John'
});

// Within a transaction
await db.transaction(async txn => {
    const user = await createPersistedEntity(User, { email: 'user@example.com' }, txn);
});
```

The `createEntity()` function uses TypeScript types to infer which fields are optional:

- `AutoIncrement` fields (like `id`)
- Nullable fields (marked with `| null`)
- Fields with `HasDefault` annotation

### Queued Entities (for batch operations)

```typescript
await db.transaction(async txn => {
    // Queue entities for batch insert
    const users = createQueuedEntities(User, [{ email: 'user1@example.com' }, { email: 'user2@example.com' }, { email: 'user3@example.com' }], txn);

    // All inserted on flush
    await txn.flush();
});
```

### Entity Retrieval Helpers

```typescript
import { getEntity, getEntityOr404, getEntityOrUndefined, entityExists } from './database';

// Get entity or throw ItemNotFound
const user = await getEntity(User, 123);
const user = await getEntity(User, { email: 'user@example.com' });

// Get entity or throw HttpNotFoundError (for HTTP handlers)
const user = await getEntityOr404(User, 123);

// Get entity or undefined
const user = await getEntityOrUndefined(User, 123);

// Check existence
if (await entityExists(User, { email })) {
    // User exists
}
```

### Entity Field Extraction

```typescript
import { getEntityFields } from './database';

// Extract only data fields (excludes methods, etc.)
const fields: EntityFields<User> = getEntityFields(user);
// Returns: { id: 1, email: '...', name: '...', createdAt: Date }
```

## Query Builder Customization

BaseDatabase modifies Deepkit's query builder behavior:

```typescript
// In BaseDatabase, .clone() returns the same instance (not a copy)
// This improves performance but means queries are not reusable
const query = db.query(User).filter({ active: true });
const result1 = await query.limit(10).find();
// query is now modified! Don't reuse it

// If you need a reusable base query, create a function:
const getActiveUsersQuery = () => db.query(User).filter({ active: true });
const result1 = await getActiveUsersQuery().limit(10).find();
const result2 = await getActiveUsersQuery().orderBy('createdAt', 'desc').find();
```

## Migration System (migration/)

### Running Migrations

```typescript
import { runMigrations } from './database';

// Run all pending migrations using the application's configured database
await runMigrations();

// At runtime, migrations are read from getMigrationsDir() (src/ or dist/ depending on context)
// migration:create and migration:reset always write to getSourceMigrationsDir() (src/migrations/)
// Migration state is tracked in the database's migration table
```

### Creating Migrations

```typescript
import { createMigration } from './database';

// Define a migration (exported from a file under src/database/migration/**)
export default createMigration(async db => {
    await db.rawExecute(/* ... */);
});
```

### Character Set Standardization (MySQL-only)

```typescript
import { standardizeDbCollation } from './database';

// Ensure all tables use utf8mb4_0900_ai_ci collation (MySQL-only, no-ops on PostgreSQL)
await standardizeDbCollation(db);
```

## Best Practices

1. **Always use transactions for multi-step operations**

    ```typescript
    await db.transaction(async session => {
        const user = await createPersistedEntity(User, data, session);
        const profile = await createPersistedEntity(Profile, { userId: user.id }, session);
    });
    ```

2. **Use session locks to prevent race conditions**

    ```typescript
    await db.transaction(async session => {
        await session.acquireSessionLock(['wallet', walletId]);
        // Now safe to read-modify-write
    });
    ```

3. **Leverage pre/post commit hooks for side effects**

    ```typescript
    session.addPostCommitHook(async () => {
        // Queue job, send notification, etc.
        // Only runs if transaction succeeds
    });
    ```

4. **Use type-safe entity creation helpers**

    ```typescript
    // Good: Type-safe, handles optionals
    const user = createEntity(User, { email, name });

    // Avoid: Manual instantiation loses type safety
    const user = new User();
    user.email = email;
    user.name = name;
    ```

5. **Disable identity maps** (already done by BaseDatabase)
    - Identity maps are disabled (`session.withIdentityMap = false`) to prevent stale data issues
    - Each query returns fresh data from the database

## Common Patterns

### Optimistic Locking with Version Field

```typescript
@entity.name('document')
class Document {
    @entity.column
    version: number = 0;

    @entity.column
    content!: string;
}

await db.transaction(async session => {
    const doc = await session.query(Document).filter({ id }).findOne();
    const originalVersion = doc.version;

    doc.content = newContent;
    doc.version++;

    const updated = await db.rawExecute(
        sql`UPDATE documents SET content = ${doc.content}, version = ${doc.version}
            WHERE id = ${doc.id} AND version = ${originalVersion}`,
        session
    );

    if (updated.affectedRows === 0) {
        throw new Error('Document was modified by another process');
    }
});
```

### Bulk Operations with Raw SQL

```typescript
// Bulk insert
await db.rawExecute(sql`
    INSERT INTO users (email, name)
    VALUES
        ${'user1@example.com'}, ${'User 1'},
        ${'user2@example.com'}, ${'User 2'}
`);

// Bulk update
await db.rawExecute(sql`
    UPDATE users
    SET active = ${false}
    WHERE lastLoginAt < ${cutoffDate}
`);
```
