# Database

MySQL/MariaDB ORM layer extending Deepkit's database with transaction hooks, session locks, raw query helpers, entity creation utilities, dirty tracking, relationship resolution, and a migration system.

## Creating a Database

Use `createMySQLDatabase()` to define a database class with your entities:

```typescript
import { createMySQLDatabase } from '@zyno-io/dk-server-foundation';

class AppDB extends createMySQLDatabase({ enableLocksTable: true }, [User, Post, Comment]) {}
```

Pass the database class to `createApp()`:

```typescript
const app = createApp({
    config: AppConfig,
    db: AppDB
});
```

### `createMySQLDatabase(config, entities?)`

| Option             | Type      | Default | Description                                          |
| ------------------ | --------- | ------- | ---------------------------------------------------- |
| `enableLocksTable` | `boolean` | `false` | Create the `_locks` table for session-level locking. |

All other MySQL connection options are configured via environment variables (see [Configuration](./configuration.md)).

### Choosing the dialect at runtime — `createDatabase()`

For dialect-agnostic apps, use `createDatabase()` to select MySQL or PostgreSQL via configuration instead of importing one factory or the other.

```typescript
import { createDatabase } from '@zyno-io/dk-server-foundation';

// Reads DB_ADAPTER ('mysql' or 'postgres') from the environment at module load
class AppDB extends createDatabase({ enableLocksTable: true }, [User, Post, Comment]) {}

// Or be explicit (each form keeps its dialect-specific pool config)
class AppDB extends createDatabase('mysql', { connectionLimit: 20, enableLocksTable: true }, [User]) {}
class AppDB extends createDatabase('postgres', { max: 20, enableLocksTable: true }, [User]) {}
```

The shared form only accepts `enableLocksTable`; pool tuning is done via the `MYSQL_*` / `PG_*` env vars. The shared form requires `DB_ADAPTER` to be set and throws at call time if it isn't — use the explicit form when you don't want that dependency.

Both forms delegate to `createMySQLDatabase` or `createPostgresDatabase` and return the same kind of class — a subclass of `BaseDatabase`. The existing single-dialect factories remain available.

## Entity Creation

Type-safe entity creation with automatic inference of optional fields (auto-increment, nullable, or `HasDefault`).

### Create Without Persisting

```typescript
import { createEntity, createEntities } from '@zyno-io/dk-server-foundation';

const user = createEntity(User, { email: 'a@b.com', name: 'Alice' });
const users = createEntities(User, [
    { email: 'a@b.com', name: 'Alice' },
    { email: 'b@c.com', name: 'Bob' }
]);
```

### Create and Queue for Persistence

Entities are added to the session's unit of work but not flushed until `session.flush()`:

```typescript
import { createQueuedEntity } from '@zyno-io/dk-server-foundation';

await db.transaction(async session => {
    const user = createQueuedEntity(User, { email: 'a@b.com', name: 'Alice' }, session);
    const post = createQueuedEntity(Post, { userId: user.id, title: 'Hello' }, session);
    // Both persisted on commit
});
```

### Create and Persist Immediately

```typescript
import { createPersistedEntity, createPersistedEntities } from '@zyno-io/dk-server-foundation';

const user = await createPersistedEntity(User, { email: 'a@b.com', name: 'Alice' }, session);
```

### Persist Existing Entities

```typescript
import { persistEntity, persistEntities } from '@zyno-io/dk-server-foundation';

const user = createEntity(User, { email: 'a@b.com', name: 'Alice' });
await persistEntity(user, session);
```

## Entity Retrieval

```typescript
import { getEntityOr404, getEntityOrUndefined, getEntity, entityExists } from '@zyno-io/dk-server-foundation';

// Throws HttpNotFoundError if not found
const user = await getEntityOr404(User, { id: 1 });

// Returns undefined if not found
const user = await getEntityOrUndefined(User, { id: 1 });

// Throws Deepkit ItemNotFound if not found
const user = await getEntity(User, { id: 1 });

// Check existence
const exists = await entityExists(User, { email: 'a@b.com' });
```

## Transactions and Sessions

### Transactions

```typescript
await db.transaction(async session => {
    // All operations within this callback are wrapped in a transaction
    const user = createQueuedEntity(User, { name: 'Alice' }, session);
    // Auto-commits on success, auto-rollbacks on error
});
```

### Sessions (No Transaction)

```typescript
await db.session(async session => {
    // Unit of work without an explicit transaction
});
```

### Reuse or Create

```typescript
// Uses existing session if provided, otherwise creates a new transaction
await db.withTransaction(existingSession, async session => {
    // ...
});

// Same for sessions (no transaction)
await db.withSession(existingSession, async session => {
    // ...
});
```

### Transaction Hooks

```typescript
await db.transaction(async session => {
    session.addPreCommitHook(async () => {
        // Runs before the transaction commits
    });

    session.addPostCommitHook(async () => {
        // Runs after successful commit
        // Good for sending notifications, invalidating caches
    });
});
```

### Session Locks

Acquire database-level locks that are held until the transaction completes. Requires `enableLocksTable: true` in database config.

```typescript
await db.transaction(async session => {
    await session.acquireSessionLock(['wallet', walletId]);
    // Lock held until commit/rollback
    // Other transactions attempting the same lock will wait
});
```

Lock keys can be a single value or an array that gets flattened: `['wallet', 123]` becomes `wallet:123`.

## Raw Queries

### Tagged Template Literals

Use Deepkit's `sql` tagged template for parameterized queries:

```typescript
import { sql } from '@deepkit/sql';

const users = await db.rawFind<User>(sql`SELECT * FROM users WHERE active = ${true} AND age > ${18}`);

await db.rawExecute(sql`UPDATE users SET last_login = NOW() WHERE id = ${userId}`);
```

### Single Result

```typescript
const user = await db.rawFindOne<User>(sql`SELECT * FROM users WHERE id = ${id}`);
// Returns undefined if not found
```

### Unsafe (Manual Bindings)

```typescript
const users = await db.rawFindUnsafe<User>('SELECT * FROM users WHERE name LIKE ?', ['%alice%']);
```

### Execute Results

```typescript
const result = await db.rawExecute(sql`INSERT INTO users ...`);
// result: { affectedRows, insertId, warningStatus }
```

## Dirty Tracking

Track changes to entities loaded from the database:

```typescript
import {
    isEntityDirty,
    getDirtyFields,
    getDirtyDetails,
    isFieldDirty,
    getFieldOriginal,
    getEntityOriginal,
    revertDirtyEntity
} from '@zyno-io/dk-server-foundation';

user.name = 'Bob';

isEntityDirty(user); // true
getDirtyFields(user); // ['name']
isFieldDirty(user, 'name'); // true
getFieldOriginal(user, 'name'); // 'Alice'

getDirtyDetails(user);
// { name: { original: 'Alice', current: 'Bob' } }

getEntityOriginal(user);
// { id: 1, name: 'Alice', email: '...' }

revertDirtyEntity(user);
// user.name is now 'Alice' again
```

## Bulk Loading

### Keyed Entities

Load entities indexed by a field:

```typescript
import { getKeyedEntities, getKeyedGroupedEntities, getEntitiesById } from '@zyno-io/dk-server-foundation';

// Returns { [userId]: User }
const usersById = await getKeyedEntities({
    schema: User,
    ids: [1, 2, 3],
    keyField: 'id'
});

// Returns { [departmentId]: User[] }
const usersByDept = await getKeyedGroupedEntities({
    schema: User,
    ids: [10, 20],
    keyField: 'departmentId'
});

// Returns User[]
const users = await getEntitiesById({
    schema: User,
    ids: [1, 2, 3],
    fields: ['id', 'name', 'email']
});
```

### Relationship Resolution

Resolve one-to-one/many-to-one and many-to-many relationships:

```typescript
import { resolveRelated, resolveRelatedByPivot } from '@zyno-io/dk-server-foundation';

// Many-to-one: attach department to each user
await resolveRelated({
    src: users,
    srcIdField: 'departmentId',
    targetField: 'department',
    targetSchema: Department,
    targetFields: ['id', 'name']
});
// users[0].department = Department { id, name }

// Many-to-many via pivot table
await resolveRelatedByPivot({
    src: posts,
    srcIdField: 'id',
    pivotSchema: PostTag,
    pivotIdKey: 'postId',
    pivotRelatedKey: 'tagId',
    targetField: 'tags',
    targetSchema: Tag,
    targetFields: ['id', 'name']
});
// posts[0].tags = [{ ...Tag, pivot: PostTag }, ...]
```

## Custom Types

### Coordinate (POINT)

```typescript
import { Coordinate, MySQLCoordinate, NullableMySQLCoordinate } from '@zyno-io/dk-server-foundation';

class Location {
    coords!: MySQLCoordinate; // NOT NULL POINT
    altCoords!: NullableMySQLCoordinate; // NULLABLE POINT
}
```

### DateString

```typescript
import { DateString } from '@zyno-io/dk-server-foundation';

class Event {
    date!: DateString; // MySQL DATE column, stored as 'YYYY-MM-DD'
}
```

### UuidString

```typescript
import { UuidString } from '@zyno-io/dk-server-foundation';

class Resource {
    id!: UuidString; // Type annotation for UUID fields
}
```

### Length

```typescript
import { Length } from '@zyno-io/dk-server-foundation';

class Token {
    code!: Length<6>; // Validated fixed-length string
}
```

### HasDefault

Mark fields that have application-level defaults so they become optional in `createEntity()`:

```typescript
import { HasDefault } from '@zyno-io/dk-server-foundation';

class User {
    role!: string & HasDefault; // Optional in createEntity()
}
```

## Schema Builder (multi-dialect)

`db.schema` is a Laravel-style fluent schema builder that emits dialect-appropriate SQL at runtime, so a single migration file works on both MySQL and PostgreSQL.

```typescript
export default createMigration(async db => {
    await db.schema.create('users', t => {
        t.id();
        t.string('email', 255).notNull().unique();
        t.string('name', 255).nullable();
        t.boolean('active').notNull().default(false);
        t.json('metadata').nullable();
        t.enum('status', ['active', 'pending']).notNull().default('pending');
        t.dateTime('createdAt').notNull().defaultRaw('CURRENT_TIMESTAMP');
        t.dateTime('updatedAt').notNull().defaultRaw('CURRENT_TIMESTAMP').onUpdate('CURRENT_TIMESTAMP');
    });

    await db.schema.create('posts', t => {
        t.id();
        t.bigInteger('userId').unsigned().notNull();
        t.string('title', 200).notNull();
        t.text('body').nullable();
        t.foreign('userId').references('id').on('users').onDelete('cascade');
        t.index('userId');
    });

    // Escape hatches
    await db.schema.raw(`UPDATE users SET active = TRUE WHERE id < 100`);
    await db.schema.onlyOn('postgres', () => db.rawExecute(`CREATE EXTENSION IF NOT EXISTS pg_trgm`));
});
```

### Column types

| Method | MySQL | Postgres |
| ------ | ----- | -------- |
| `id(name='id')` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` |
| `string(name, len=255)` | `VARCHAR(len)` | `VARCHAR(len)` |
| `char(name, len=1)` | `CHAR(len)` | `CHAR(len)` |
| `text(name)` | `TEXT` | `TEXT` |
| `tinyint`, `smallint`, `integer`, `bigInteger` | `TINYINT`, `SMALLINT`, `INT`, `BIGINT` | `SMALLINT`, `INTEGER`, `BIGINT` (`tinyint` → `SMALLINT`) |
| `boolean(name)` | `TINYINT(1)` | `BOOLEAN` |
| `float`, `double`, `decimal(name, p?, s?)` | `FLOAT`, `DOUBLE`, `DECIMAL(p,s)` | `REAL`, `DOUBLE PRECISION`, `NUMERIC(p,s)` |
| `date(name)` | `DATE` | `DATE` |
| `dateTime(name)` | `DATETIME` | `TIMESTAMP` |
| `timestamp(name)` | `TIMESTAMP` | `TIMESTAMP` |
| `timestamptz(name)` | `TIMESTAMP` | `TIMESTAMPTZ` |
| `binary(name, len=16)` | `BINARY(len)` | `BYTEA` |
| `blob(name)` | `BLOB` | `BYTEA` |
| `json(name)` | `JSON` | `JSON` |
| `jsonb(name)` | `JSON` | `JSONB` |
| `uuid(name)` | `BINARY(16)` (canonical) | `UUID` |
| `uuidString(name)` | `CHAR(36)` | `CHAR(36)` |
| `enum(name, values, typeName?)` | `ENUM(...)` inline | `CREATE TYPE` (deduped) + qualified ref |
| `point(name)` | `POINT` | **throws** (MySQL-only) |

### Modifiers

`.nullable()`, `.notNull()`, `.default(value)`, `.defaultRaw(expression)`, `.unsigned()` (MySQL-only, ignored on PG), `.onUpdate(expression)` (MySQL-only), `.autoIncrement()`, `.primary()`, `.unique(name?)`, `.index(name?)`, `.references(col).on(table).onDelete(action).onUpdate(action)`.

### Table-level

`.timestamps()` (createdAt + updatedAt with `CURRENT_TIMESTAMP`), `.primary([cols])` (composite PK), `.index(cols, name?)`, `.unique(cols, name?)`, `.spatialIndex(cols, name?)` (MySQL POINT), `.foreign(cols, name?).references(...).on(...)`.

### Schema operations

`db.schema.create(name, fn)`, `db.schema.alter(name, fn)`, `db.schema.drop(name)`, `db.schema.dropIfExists(name)`, `db.schema.rename(from, to)`, `db.schema.enumType(name, values)` (PG explicit type), `db.schema.raw(sql)`, `db.schema.onlyOn(dialect, fn)`.

### Introspection (for idempotent migrations)

```typescript
if (!(await db.schema.hasTable('users'))) { /* ... */ }
if (await db.schema.hasColumn('users', 'phone')) { /* ... */ }
if (await db.schema.hasIndex('users', 'users_email_unique')) { /* ... */ }
```

### Altering tables — `db.schema.alter()`

```typescript
await db.schema.alter('users', t => {
    // Add columns (same syntax as create)
    t.string('phone', 20).nullable();
    t.boolean('archived').notNull().default(false);

    // Modify an existing column (Laravel-style .change() suffix)
    t.string('email', 500).notNull().change();

    // Drop / rename columns
    t.dropColumn('legacyField');
    t.renameColumn('old_name', 'new_name');

    // Indexes & foreign keys
    t.index('phone');
    t.dropUnique('users_email_unique');
    t.foreign('orgId').references('id').on('orgs').onDelete('cascade');
    t.dropForeign('users_old_fk');

    // Primary key
    t.dropPrimary();
    t.primary(['a', 'b']);
});
```

Operations execute in dependency-safe order: drop FKs → drop indexes → drop PK → drop columns → rename columns → PG enum type prep → add columns → modify columns → add PK → add indexes → defer added FKs to flush. Added FKs are deferred (same as `create()`) so cross-table refs resolve.

### How FK ordering works

Inline FKs declared via `t.foreign(...)` are deferred and emitted as `ALTER TABLE ... ADD CONSTRAINT` after all `CREATE TABLE`s in the migration complete. The migration runner calls `db.schema.flush()` automatically; you can also call it manually if you need FKs applied mid-migration. PG enum types are deduplicated per-migration via the `enumTypeName` (so the same shared enum across two tables emits only one `CREATE TYPE` + `CREATE CAST`).

## Migrations

### Generating Migrations

The `migration:create` command diffs entity definitions against the live database and generates a migration file:

```bash
# Interactive mode (prompts for column renames)
node app.js migration:create

# Non-interactive (CI-safe, treats ambiguous changes as drop+add)
node app.js migration:create --non-interactive
```

It detects: table creation/removal, column additions/removals/modifications/renames, index and foreign key changes, primary key changes, and PostgreSQL enum type management. Both MySQL and PostgreSQL are supported.

### Writing Migrations Manually

```typescript
// src/migrations/20240101_120000_add_users.ts
import { createMigration } from '@zyno-io/dk-server-foundation';

export default createMigration(async db => {
    await db.rawExecute(sql`
        CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL
        )
    `);
});
```

### Running Migrations

```bash
# Via CLI
node app.js migration:run

# Programmatically
import { runMigrations } from '@zyno-io/dk-server-foundation';
await runMigrations();
```

### Reset Migrations

Removes all existing migrations and generates a single base migration from entity definitions:

```bash
node app.js migration:reset
```

### Character Set Standardization

```bash
node app.js migration:charset [charset] [collation]
# Defaults: utf8mb4, utf8mb4_0900_ai_ci
```

Or programmatically:

```typescript
import { standardizeDbCollation } from '@zyno-io/dk-server-foundation';
await standardizeDbCollation(db);
```

## Entity Utility Functions

```typescript
import { getPKFieldForEntity, getEntityFields, logSql } from '@zyno-io/dk-server-foundation';

// Get primary key field name
const pk = getPKFieldForEntity(User); // 'id'

// Extract only data fields (no methods or relations)
const fields = getEntityFields(user);

// Debug SQL output
logSql('SELECT * FROM users WHERE id = ?', [1]);
```
