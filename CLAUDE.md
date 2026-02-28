# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@zyno-io/dk-server-foundation` is a TypeScript foundation library built on top of the Deepkit framework for building server applications. It provides opinionated abstractions and utilities for common server-side patterns including database management, HTTP handling, authentication, workers, RPC, and observability.

Detailed documentation lives in `docs/content/` — see `docs/content/README.md` for the full index. When updating features, update the corresponding doc file there too.

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
yarn devconsole-demo
```

## Architecture Overview

### Application Creation Pattern

Applications are created using the `createApp()` factory function (src/app/base.ts), which sets up a Deepkit application with opinionated defaults:

- **Dependency Injection**: Uses Deepkit's DI system with custom resolver functions (`resolve()` or `r()`) for accessing providers
- **Configuration**: Uses `@zyno-io/config` with a custom loader (CustomConfigLoader) that supports environment variables and defaults
- **Module System**: Based on Deepkit's module architecture with framework, HTTP, healthcheck, and optional DevConsole/OpenAPI modules (dev only)

Key concepts:

- `createApp()` accepts a config class, database class, framework config, CORS options, and feature flags (worker, Deepkit RPC)
- **Port in tests**: When `APP_ENV=test`, the `PORT` config value is ignored; the server uses the hardcoded default (3000) or `frameworkConfig.port` if provided
- Use `@AutoStart()` decorator on services that should initialize at startup (before DI injection)
- **Graceful Shutdown**: `ShutdownListener` (src/app/shutdown.ts) intercepts SIGTERM/SIGINT and dispatches `onServerShutdownRequested` before forwarding to Deepkit's built-in shutdown

### Database Layer

The database system (src/database/) extends Deepkit's ORM with support for both MySQL and PostgreSQL. See `docs/content/database.md` and `src/database/CLAUDE.md` for full details.

- **BaseDatabase**: Core abstraction with transaction hooks, raw query helpers, and session management (src/database/common.ts)
- **MySQLDatabaseAdapter** / **PostgresDatabaseAdapter**: Custom adapters with type transformations (src/database/mysql.ts, src/database/postgres.ts)
- **Entity Helpers**: `createEntity()`, `createPersistedEntity()`, `getEntityOr404()` for common CRUD patterns
- **Transaction Hooks**: Pre-commit and post-commit hooks via `session.addPreCommitHook()` / `session.addPostCommitHook()`
- **Session Locks**: `session.acquireSessionLock(key)` — uses `_locks` table on MySQL, `pg_advisory_xact_lock` on PostgreSQL

### HTTP Layer

Custom HTTP handling (src/http/) builds on Deepkit's HTTP module. See `docs/content/http.md` for details.

Response types: Use `OkResponse`, `RedirectResponse`, `EmptyResponse`, or `AnyResponse` for type-safe returns.

### Worker System

Background job processing (src/services/worker/) using BullMQ with Redis. See `docs/content/worker.md` and `src/services/worker/CLAUDE.md` for details.

Jobs are automatically registered when `enableWorker: true` is passed to `createApp()`.

### SRPC (Simple RPC)

Custom bidirectional RPC system (src/srpc/) over WebSocket. See `docs/content/srpc.md` and `src/srpc/CLAUDE.md` for details.

Use `dksf-gen-proto` CLI to generate TypeScript types from `.proto` files using ts-proto.

### Observability

Integrated telemetry (src/telemetry/). See `docs/content/telemetry.md` for details.

Initialize telemetry by calling `init()` from src/telemetry/otel/index.ts before other imports.

### Helper Utilities

Organized by category (src/helpers/). See `docs/content/helpers.md` and `src/helpers/CLAUDE.md` for details.

### Configuration

Configuration (src/app/config.ts) uses `@zyno-io/config` with environment variable support. See `docs/content/configuration.md` for the full reference.

### Test Infrastructure

- Tests use `node:test` runner against compiled output in `dist/`
- Test compilation: `tsc -p tsconfig.test.json` compiles `tests/` into `dist/tests/`
- Test runner: `dksf-test` CLI tool (src/cli/dksf-test.ts) handles spawning `node --test`
- Test files use `*.spec.ts` naming convention
- Test timeout: 180 seconds (high to accommodate `describe()` suite-level timeouts on Node 24+)
- Testing utilities: `TestingHelpers.createTestingFacade()`, `makeMockRequest()` (src/testing/)
- Database tests use `forEachAdapter()` to run against both MySQL and PostgreSQL
- Tests require MySQL and Redis; PostgreSQL tests run when `PG_HOST` is set (skipped otherwise)

See `docs/content/testing.md` for more.

### Type System

Custom types (src/types/): Phone, Coordinate (MySQL POINT), OnUpdate, DateString, and more. See `docs/content/types.md`.

Deepkit reflection is enabled (`"reflection": true` in tsconfig.json).

## Important Notes

- **Timezone**: Server always uses UTC. The index.ts enforces this and will throw an error if TZ !== UTC
- **Identity Maps**: Disabled by default (`session.withIdentityMap = false`) in transactions and sessions
- **Query Cloning**: The library overrides Deepkit's query cloning behavior to return the same instance for performance
- **Decorators**: TypeScript experimental decorators are required (`experimentalDecorators: true`)
- **Postinstall**: Runs `dksf-install` CLI tool (or `patch-package && deepkit-type-install` as fallback)
- **Test Environment**: Special handling for Date mocks and worker queueing (jobs are not queued in test environment)
- **Dual Database Support**: Both MySQL (`@deepkit/mysql`) and PostgreSQL (`@deepkit/postgres`) are supported. Coordinate/POINT type is MySQL-only.

## CLI Tools

- `dksf-dev`: All-in-one dev workflow (clean, build, run, migrate, repl, test) with `-p/--tsconfig` support
- `dksf-test`: Test runner that compiles and runs `node --test`
- `dksf-install`: Post-install script for setup
- `dksf-update`: Update utility
- `dksf-gen-proto`: Generate TypeScript types from .proto files using ts-proto

See `docs/content/cli.md` for full details.

## Development Mode Features

When `APP_ENV !== 'production'`:

- **DevConsole**: Built-in web dashboard at `/_devconsole/`. See `docs/content/devconsole.md` for full details. Frontend is a Vue 3 SPA in `devconsole/` that builds to `dist/devconsole/`. Server-side code lives in `src/devconsole/` — `patches.ts` monkey-patches core components to intercept events; `devconsole.store.ts` holds ring buffers; `devconsole.ws.ts` is the SRPC server; `devconsole.controller.ts` serves static assets. Proto definitions are in `resources/proto/devconsole.proto` — run `yarn gen:proto` after changes.
- **Demo App**: `yarn devconsole-demo` runs a demo app with auto-generated traffic to showcase all DevConsole features
- Set `ENABLE_OPENAPI_SCHEMA` to also dump the schema to `openapi.yaml` on disk
- Lower MySQL/PostgreSQL connection pool limits (5 vs 10)
- Shorter idle timeouts

## Migration System

Database migrations (src/database/migration/). See `docs/content/database.md` for the full migration reference.

### Migration Commands

- `migration:create` — Compares entity definitions against the live database and generates a migration file with the DDL to bring the DB in sync. Supports `--non-interactive` flag for CI. Both MySQL and PostgreSQL.
- `migration:run` — Executes all pending migrations from the migrations directory
- `migration:reset` — Removes all migrations and regenerates a base migration from entity definitions
- `migration:charset` — Standardizes character set/collation to `utf8mb4_0900_ai_ci` (MySQL-only)

### Schema Migration Generator (`migration:create`)

The `migration:create` command (src/database/migration/create/) is a custom implementation that:

1. **Reads entity schema** via Deepkit's `ReflectionClass` — resolves all type annotations to dialect-specific column types
2. **Reads database schema** via `information_schema` queries — introspects columns, indexes, foreign keys, and enum types
3. **Compares schemas** — diffs entity vs DB to detect added/removed/modified tables, columns, indexes, FKs, and PK changes. Supports interactive rename detection and MySQL column reordering
4. **Generates DDL** — produces dialect-specific SQL statements (MySQL uses backtick quoting, `MODIFY COLUMN`, `ENUM()`, `AFTER`; PostgreSQL uses double-quote quoting, `ALTER COLUMN`, `CREATE TYPE ... AS ENUM`)
5. **Writes migration file** — outputs a timestamped `.ts` file using the `createMigration()` format
