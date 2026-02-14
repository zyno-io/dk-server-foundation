# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@signal24/dk-server-foundation` is a TypeScript foundation library built on top of the Deepkit framework for building server applications. It provides opinionated abstractions and utilities for common server-side patterns including database management, HTTP handling, authentication, workers, RPC, and observability.

## Core Commands

### Build & Development

```bash
# Clean build (removes dist/ and rebuilds everything)
yarn build

# Quick rebuild (doesn't clean first)
yarn build:dirty

# Watch mode
yarn dev
```

### Testing

```bash
# Run all tests
yarn test

# Run tests with debugger
yarn test:debug

# Run a single test file
yarn test path/to/file.spec.ts
```

### Code Quality

```bash
# Format code with Prettier and fix ESLint issues
yarn format
```

### Test & Demo Applications

```bash
# Build and run the test application
yarn testapp

# Run the demo app (showcases DevConsole features)
yarn demoapp
```

## Architecture Overview

### Application Creation Pattern

Applications are created using the `createApp()` factory function (src/app/base.ts:43), which sets up a Deepkit application with opinionated defaults:

- **Dependency Injection**: Uses Deepkit's DI system with custom resolver functions (`resolve()` or `r()`) for accessing providers
- **Configuration**: Uses `@signal24/config` with a custom loader (CustomConfigLoader) that supports environment variables and defaults
- **Module System**: Based on Deepkit's module architecture with framework, HTTP, healthcheck, and optional DevConsole/OpenAPI modules (dev only)

Key concepts:

- `createApp()` accepts a config class, database class, framework config, CORS options, and feature flags (worker, Deepkit RPC)
- The function returns a configured Deepkit App instance with all necessary providers, listeners, and hooks
- Use `@AutoStart()` decorator on services that should initialize at startup (before DI injection)
- **Graceful Shutdown**: `ShutdownListener` (src/app/shutdown.ts) intercepts SIGTERM/SIGINT and dispatches `onServerShutdownRequested` before forwarding to Deepkit's built-in shutdown. Listeners on this event are awaited, allowing async cleanup before the framework tears down. Register handlers via `@eventDispatcher.listen(onServerShutdownRequested)`.

### Database Layer

The database system (src/database/) extends Deepkit's ORM with support for both MySQL and PostgreSQL:

- **BaseDatabase**: Core abstraction with transaction hooks, raw query helpers, and session management (src/database/common.ts)
- **MySQLDatabaseAdapter**: Custom adapter with type transformations for DateString, Coordinate (POINT), and test environment compatibility (src/database/mysql.ts)
- **PostgresDatabaseAdapter**: Custom adapter with type transformations for DateString and test environment compatibility (src/database/postgres.ts)
- **Dialect Helpers**: `getDialect()`, `quoteId()`, and dialect-aware SQL fragment generators (src/database/dialect.ts)
- **Entity Helpers**: Functions like `createEntity()`, `createPersistedEntity()`, `getEntityOr404()` for common CRUD patterns
- **Transaction Hooks**: Support for pre-commit and post-commit hooks via `session.addPreCommitHook()` and `session.addPostCommitHook()`
- **Session Locks**: Database-level locking via `session.acquireSessionLock(key)` — uses a `_locks` table on MySQL, `pg_advisory_xact_lock` on PostgreSQL

Entity creation pattern:

```typescript
// Use createPersistedEntity instead of manually creating and saving
await createPersistedEntity(MyEntity, { field: value }, session);
```

Database factory:

```typescript
// MySQL
class MyDB extends createMySQLDatabase(
    {
        /* pool config */
    },
    [Entity1, Entity2]
) {}

// PostgreSQL
class MyDB extends createPostgresDatabase(
    {
        /* pool config */
    },
    [Entity1, Entity2]
) {}
```

### HTTP Layer

Custom HTTP handling (src/http/) builds on Deepkit's HTTP module:

- **CustomHttpKernel**: Replaces Deepkit's default HttpKernel with custom middleware and error handling (src/http/kernel.ts)
- **HTTP Context**: Request context ID generation and pluggable context resolver (src/http/context.ts)
- **CORS Support**: Multi-origin CORS configuration via HttpCorsListener (src/http/cors.ts)
- **Authentication**: JWT and Basic Auth providers with decorator-based guards (src/http/auth.ts)
- **File Uploads**: Support for multipart uploads with `multipartJsonKey: '_payload'` configuration
- **Workflow**: Custom workflow listener for pre/post request hooks (src/http/workflow.ts)

Response types: Use `OkResponse`, `RedirectResponse`, `EmptyResponse`, or `AnyResponse` for type-safe returns.

### Worker System

Background job processing (src/services/worker/) using BullMQ with Redis:

- **BaseJob**: Extend this class and use `@WorkerJob()` decorator to define jobs
- **WorkerService**: Queue jobs via `workerSvc.queueJob(JobClass, data, options)`
- **Job Runners**: Separate process workers that execute queued jobs (src/services/worker/runner.ts)
- **Job Observer**: Monitors job completion and failures (src/services/worker/observer.ts)

Jobs are automatically registered when `enableWorker: true` is passed to `createApp()`.

Job pattern:

```typescript
@WorkerJob()
class MyJob extends BaseJob<InputType, OutputType> {
    async handle(data: InputType): Promise<OutputType> {
        // Job logic
    }
}
```

### SRPC (Simple RPC)

Custom bidirectional RPC system (src/srpc/) over WebSocket:

- **SrpcServer**: Server-side RPC handler with WebSocket transport
- **SrpcClient**: WebSocket client with reconnect and heartbeat
- **SrpcByteStream**: Efficient binary streaming over existing connections

Use `dksf-gen-proto` CLI to generate TypeScript types from `.proto` files using ts-proto.

Authentication uses HMAC signatures with clock drift tolerance (configurable via `SRPC_AUTH_CLOCK_DRIFT_MS`).

### Observability

Integrated telemetry (src/telemetry/):

- **OpenTelemetry**: Automatic instrumentation for HTTP, database, Redis, DNS, and BullMQ (src/telemetry/otel/)
- **Sentry**: Error tracking with automatic flushing on uncaught exceptions
- **Custom Metrics**: MariaDB instrumentation (src/telemetry/otel/MariaDBInstrumentation.ts)
- **Tracing Helpers**: `withRootSpan()` and `withSpan()` for manual span creation

Initialize telemetry by calling `init()` from src/telemetry/otel/index.ts before other imports.

### Helper Utilities

Organized by category (src/helpers/):

- **async/**: AsyncContext, promise helpers, process utilities
- **data/**: Array manipulation, object utilities, serialization, transformers
- **redis/**: Broadcast, cache (with TTL), mutex (Redis-backed distributed locking)
- **security/**: Crypto (AES-GCM encryption), validation helpers
- **io/**: Package metadata helpers, stream utilities
- **utils/**: Date utilities, error handling, UUID v7 generation
- **framework/**: Deepkit-specific decorators and injection helpers

### Configuration

Configuration (src/app/config.ts) uses `@signal24/config` with environment variable support:

- `BaseAppConfig`: Contains all framework-level configuration (MySQL, PostgreSQL, Redis, Auth, Mail, etc.)
- Applications should extend BaseAppConfig with their own settings
- Config is available via `getAppConfig()` or by injecting the config class
- Secrets should use `_SECRET` suffix in environment variable names

### Services

Core services (src/services/):

- **Logger**: Extended Pino logger with scoped instances via `createLogger(this)` (src/services/logger.ts)
- **MailService**: Email sending via Postmark or SMTP (src/services/mail/)
- **CLI Commands**: REPL (`ReplCommand`) and provider invoke (`ProviderInvokeCommand`) for debugging
- **WorkerService**: Background job queueing (see Worker System above)

### Test Infrastructure

Test infrastructure (tests/):

- Tests use `node:test` runner against compiled output in `dist/`
- Test compilation: `tsc -p tsconfig.test.json` compiles `tests/` into `dist/tests/`
- Test runner: `dksf-test` CLI tool (src/cli/dksf-test.ts) handles spawning `node --test`
- Global setup enforces UTC timezone (tests/shared/globalSetup.ts)
- Test files use `*.spec.ts` naming convention
- Test timeout: 180 seconds (high to accommodate `describe()` suite-level timeouts on Node 24+)
- Testing utilities: `TestingHelpers.createTestingFacade()`, `makeMockRequest()` (src/testing/)
- Database tests use `forEachAdapter()` to run against both MySQL and PostgreSQL
- Tests require MySQL and Redis; PostgreSQL tests run when `PG_HOST` is set (skipped otherwise)

Run a single test:

```bash
yarn test tests/helpers/array.spec.ts
```

### Type System

Custom types (src/types/):

- **Phone**: Google libphonenumber integration for phone number validation
- **Coordinate**: Geo-coordinates with MySQL POINT support (MySQL-only)
- **OnUpdate**: MySQL `ON UPDATE` expression annotation (e.g., `Date & OnUpdate<'CURRENT_TIMESTAMP'>`)
- Deepkit reflection is enabled (`"reflection": true` in tsconfig.json)

## Important Notes

- **Timezone**: Server always uses UTC. The index.ts enforces this and will throw an error if TZ !== UTC
- **Identity Maps**: Disabled by default (`session.withIdentityMap = false`) in transactions and sessions
- **Query Cloning**: The library overrides Deepkit's query cloning behavior to return the same instance for performance
- **Decorators**: TypeScript experimental decorators are required (`experimentalDecorators: true`)
- **Postinstall**: Runs `dksf-install` CLI tool (or `patch-package && deepkit-type-install` as fallback)
- **Test Environment**: Special handling for Date mocks and worker queueing (jobs are not queued in test environment)
- **Dual Database Support**: Both MySQL (`@deepkit/mysql`) and PostgreSQL (`@deepkit/postgres`) are supported. Coordinate/POINT type is MySQL-only. Session locks use `_locks` table on MySQL and `pg_advisory_xact_lock` on PostgreSQL.

## CLI Tools

- `dksf-dev`: All-in-one dev workflow (clean, build, run, migrate, repl, test) with `-p/--tsconfig` support (src/cli/dksf-dev.ts)
- `dksf-test`: Test runner that compiles and runs `node --test` (src/cli/dksf-test.ts)
- `dksf-install`: Post-install script for setup (src/cli/dksf-install.ts)
- `dksf-update`: Update utility (src/cli/dksf-update.ts)
- `dksf-gen-proto`: Generate TypeScript types from .proto files using ts-proto (src/cli/dksf-gen-proto.ts)

## Development Mode Features

When `APP_ENV !== 'production'`:

- **DevConsole**: Built-in web dashboard at `/_devconsole/`, initialized via `initDevConsole()` in `src/devconsole/patches.ts`. Provides HTTP request inspector, SRPC connection monitor, database entity browser with SQL editor, BullMQ worker inspector, Redis mutex monitor, health check viewer, environment config display, OpenAPI schema viewer, and a live REPL. Localhost-only access enforced by `DevConsoleLocalhostMiddleware`. Uses SRPC over WebSocket (`/_devconsole/ws`) for real-time push updates. Frontend is a Vue 3 SPA in `devconsole/` that builds to `dist/devconsole/`. Server-side code lives in `src/devconsole/` — `patches.ts` monkey-patches core components (HTTP kernel, SRPC, worker observer, mutex) to intercept events; `devconsole.store.ts` holds ring buffers; `devconsole.ws.ts` is the SRPC server; `devconsole.controller.ts` serves static assets.
- **Demo App**: `yarn demoapp` runs a demo app with auto-generated traffic to showcase all DevConsole features
- Set `ENABLE_OPENAPI_SCHEMA` to also dump the schema to `openapi.yaml` on disk
- Additional debugging tools in `src/app/dev.ts`
- Lower MySQL/PostgreSQL connection pool limits (5 vs 10)
- Shorter idle timeouts

## Migration System

Database migrations (src/database/migration/):

- Custom migration commands replace Deepkit's defaults
- Use `runMigrations()` helper to execute migrations programmatically
- Migrations stored in directory returned by `getMigrationsDir()`
- Character set standardization via `standardizeDbCollation()` (MySQL-only; no-ops on PostgreSQL)

### Migration Commands

- `migration:create` — Compares entity definitions against the live database and generates a migration file with the DDL to bring the DB in sync. Supports `--non-interactive` flag for CI. Both MySQL and PostgreSQL.
- `migration:run` — Executes all pending migrations from the migrations directory
- `migration:reset` — Removes all migrations and regenerates a base migration from the current database schema
- `migration:characters` — Standardizes character set/collation to `utf8mb4_0900_ai_ci` (MySQL-only)

### Schema Migration Generator (`migration:create`)

The `migration:create` command (src/database/migration/create/) is a custom implementation that:

1. **Reads entity schema** via Deepkit's `ReflectionClass` — resolves all type annotations (`DateString`, `UuidString`, `Length<N>`, `MaxLength<N>`, `MySQLCoordinate`, `OnUpdate<expr>`, enums, etc.) to dialect-specific column types
2. **Reads database schema** via `information_schema` queries — introspects columns, indexes, foreign keys, and enum types from the live database
3. **Compares schemas** — diffs entity vs DB to detect added/removed/modified tables, columns, indexes, FKs, and PK changes. Supports interactive rename detection and MySQL column reordering
4. **Generates DDL** — produces dialect-specific SQL statements (MySQL uses backtick quoting, `MODIFY COLUMN`, `ENUM()`, `AFTER`; PostgreSQL uses double-quote quoting, `ALTER COLUMN`, `CREATE TYPE ... AS ENUM`)
5. **Writes migration file** — outputs a timestamped `.ts` file using the `createMigration()` format

Key dialect differences handled:

- MySQL: inline `ENUM('a','b')`, `AFTER` clause for column ordering, `TINYINT(1)` for booleans, `AUTO_INCREMENT`
- PostgreSQL: `CREATE TYPE ... AS ENUM`, no column reordering support, native `BOOLEAN`, `SERIAL`/`BIGSERIAL`
