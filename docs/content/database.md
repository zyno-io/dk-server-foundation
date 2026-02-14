# Database

MySQL/MariaDB ORM layer extending Deepkit's database with transaction hooks, session locks, raw query helpers, entity creation utilities, dirty tracking, relationship resolution, and a migration system.

## Creating a Database

Use `createMySQLDatabase()` to define a database class with your entities:

```typescript
import { createMySQLDatabase } from '@signal24/dk-server-foundation';

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

## Entity Creation

Type-safe entity creation with automatic inference of optional fields (auto-increment, nullable, or `HasDefault`).

### Create Without Persisting

```typescript
import { createEntity, createEntities } from '@signal24/dk-server-foundation';

const user = createEntity(User, { email: 'a@b.com', name: 'Alice' });
const users = createEntities(User, [
    { email: 'a@b.com', name: 'Alice' },
    { email: 'b@c.com', name: 'Bob' }
]);
```

### Create and Queue for Persistence

Entities are added to the session's unit of work but not flushed until `session.flush()`:

```typescript
import { createQueuedEntity } from '@signal24/dk-server-foundation';

await db.transaction(async session => {
    const user = createQueuedEntity(User, { email: 'a@b.com', name: 'Alice' }, session);
    const post = createQueuedEntity(Post, { userId: user.id, title: 'Hello' }, session);
    // Both persisted on commit
});
```

### Create and Persist Immediately

```typescript
import { createPersistedEntity, createPersistedEntities } from '@signal24/dk-server-foundation';

const user = await createPersistedEntity(User, { email: 'a@b.com', name: 'Alice' }, session);
```

### Persist Existing Entities

```typescript
import { persistEntity, persistEntities } from '@signal24/dk-server-foundation';

const user = createEntity(User, { email: 'a@b.com', name: 'Alice' });
await persistEntity(user, session);
```

## Entity Retrieval

```typescript
import { getEntityOr404, getEntityOrUndefined, getEntity, entityExists } from '@signal24/dk-server-foundation';

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
} from '@signal24/dk-server-foundation';

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
import { getKeyedEntities, getKeyedGroupedEntities, getEntitiesById } from '@signal24/dk-server-foundation';

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
import { resolveRelated, resolveRelatedByPivot } from '@signal24/dk-server-foundation';

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
import { Coordinate, MySQLCoordinate, NullableMySQLCoordinate } from '@signal24/dk-server-foundation';

class Location {
    coords!: MySQLCoordinate; // NOT NULL POINT
    altCoords!: NullableMySQLCoordinate; // NULLABLE POINT
}
```

### DateString

```typescript
import { DateString } from '@signal24/dk-server-foundation';

class Event {
    date!: DateString; // MySQL DATE column, stored as 'YYYY-MM-DD'
}
```

### UuidString

```typescript
import { UuidString } from '@signal24/dk-server-foundation';

class Resource {
    id!: UuidString; // Type annotation for UUID fields
}
```

### Length

```typescript
import { Length } from '@signal24/dk-server-foundation';

class Token {
    code!: Length<6>; // Validated fixed-length string
}
```

### HasDefault

Mark fields that have application-level defaults so they become optional in `createEntity()`:

```typescript
import { HasDefault } from '@signal24/dk-server-foundation';

class User {
    role!: string & HasDefault; // Optional in createEntity()
}
```

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
import { createMigration } from '@signal24/dk-server-foundation';

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
import { runMigrations } from '@signal24/dk-server-foundation';
await runMigrations();
```

### Reset Migrations

Generates a single base migration from the current schema:

```bash
node app.js migration:reset
```

### Character Set Standardization

```bash
node app.js migration:characters [charset] [collation]
# Defaults: utf8mb4, utf8mb4_0900_ai_ci
```

Or programmatically:

```typescript
import { standardizeDbCollation } from '@signal24/dk-server-foundation';
await standardizeDbCollation(db);
```

## Entity Utility Functions

```typescript
import { getPKFieldForEntity, getEntityFields, logSql } from '@signal24/dk-server-foundation';

// Get primary key field name
const pk = getPKFieldForEntity(User); // 'id'

// Extract only data fields (no methods or relations)
const fields = getEntityFields(user);

// Debug SQL output
logSql('SELECT * FROM users WHERE id = ?', [1]);
```
