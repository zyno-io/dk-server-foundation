# CLI Tools

Built-in CLI commands and standalone tools for development, debugging, and database management.

## Application CLI Commands

These commands are available when running your app:

### REPL

Interactive Node.js REPL with access to all providers and entities:

```bash
node app.js repl
```

Inside the REPL:

- `$` -- Object containing all registered class types (for use with `r()`)
- `$$` -- Object containing resolved instances of all providers

```bash
> $$.UserService.findById(1)
> r($.MyDatabase).query($.User).find()
```

### Provider Invoke

Invoke any provider method from the command line:

```bash
node app.js provider:invoke UserService findById '[1]'
```

Arguments:

| Argument       | Description                        |
| -------------- | ---------------------------------- |
| `providerName` | Class name of the provider         |
| `methodName`   | Method to call                     |
| `argsJson`     | JSON array of arguments (optional) |

### Migration Commands

#### `migration:run`

Run all pending migrations:

```bash
node app.js migration:run
```

Behavior:

1. Scans the migrations directory for `.ts`/`.js` files
2. Creates `_migrations` table if it doesn't exist
3. Runs unexecuted migrations in alphabetical order
4. Records execution time in `_migrations` table
5. Clears repeatable worker jobs (if workers enabled)

#### `migration:create`

Generate a migration by comparing entity definitions against the live database schema:

```bash
# Interactive mode (prompts for column renames)
node app.js migration:create

# Non-interactive (CI-safe)
node app.js migration:create --non-interactive
```

Behavior:

1. Reads entity metadata via Deepkit reflection
2. Introspects the live database schema via `information_schema`
3. Compares the two and detects added/removed/modified tables, columns, indexes, foreign keys, primary key changes, and PostgreSQL enum types
4. In interactive mode, prompts to detect column renames (avoiding data loss from drop+add)
5. Generates dialect-specific DDL (MySQL or PostgreSQL)
6. Writes a timestamped migration file using `createMigration()` format

**Non-interactive mode**: Column renames cannot be detected without user input. Ambiguous changes (columns simultaneously added and removed on the same table) are treated as separate DROP/ADD operations, which may cause data loss. A warning is printed when this occurs.

#### `migration:reset`

Generate a single base migration from entity definitions:

```bash
node app.js migration:reset
```

Behavior:

1. Creates the `src/migrations/` directory if missing
2. Removes all existing `.ts` migration files
3. Reads entity schema from code definitions (using the same entity-reader as `migration:create`)
4. Generates DDL by treating all entity tables as new (using the same DDL generator as `migration:create`)
5. Writes `00000000_000000_base.ts` with all CREATE statements
6. Skips internal tables (prefixed with `_`)

#### `migration:charset`

Standardize database character set and collation:

```bash
node app.js migration:charset [charset] [collation]
```

Defaults to `utf8mb4` / `utf8mb4_0900_ai_ci`.

### Worker Commands

#### `worker:start`

Start the BullMQ job runner. One runner automatically self-elects as the job recorder via leader election:

```bash
node app.js worker:start
```

#### `worker:queue`

Queue a job by name from the command line:

```bash
node app.js worker:queue SendEmailJob '{"to":"user@example.com","subject":"Hello"}'
```

## Standalone CLI Tools

These are installed as bin scripts by the package:

### `dksf-create-app`

Scaffold a new application from the built-in template:

```bash
# Using npx (no install required)
npx @zyno-io/dk-server-foundation create-app <package-name> [path]

# Or directly if dk-server-foundation is installed
dksf-create-app <package-name> [path]
```

| Argument         | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `<package-name>` | npm package name (e.g. `@myorg/my-api` or `my-api`)      |
| `[path]`         | Output directory (defaults to the unscoped package name) |

The generated project includes:

- OTEL telemetry setup
- A single controller, service, and database entity
- MySQL database configuration
- TypeScript config with Deepkit reflection enabled
- Development environment defaults (`.env.development`)
- Standard scripts: `dev`, `build`, `test`, `migrate`, `migrate:create`, `migrate:reset`

Examples:

```bash
# Creates ./my-api/ with package name "my-api"
npx @zyno-io/dk-server-foundation create-app my-api

# Creates ./my-api/ with package name "@myorg/my-api"
npx @zyno-io/dk-server-foundation create-app @myorg/my-api

# Creates ./custom-path/ with package name "@myorg/my-api"
npx @zyno-io/dk-server-foundation create-app @myorg/my-api ./custom-path
```

### `dksf-dev`

All-in-one development workflow tool. Subcommands for cleaning, building, running dev servers, migrations, tests, and REPL.

Sets `APP_ENV=development` by default if not already set in the environment.

#### Common Options

All subcommands (except `clean`) accept:

| Option                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `-p, --tsconfig <file>` | TypeScript config file (default: `tsconfig.json`, or `tsconfig.test.json` for `test`) |

#### `dksf-dev clean`

Removes the `dist/` directory.

#### `dksf-dev build`

Cleans, then compiles with TypeScript:

```bash
# One-shot build
dksf-dev build

# Watch mode
dksf-dev build --watch
```

Without `--watch`, runs `tsc -p tsconfig.json` and exits. With `--watch`, runs `tsc -w --preserveWatchOutput -p tsconfig.json` (use Ctrl+C to stop).

#### `dksf-dev run`

Cleans, starts `tsc --watch`, and once the initial compilation completes, starts the application with `node --watch`. The first `run` process owns the `tsc --watch` for continuous recompilation:

```bash
# Default: node --watch --inspect . server:start
dksf-dev run

# Run a different command
dksf-dev run -- nats:process

# Custom script entrypoint
dksf-dev run ./src/other.js

# Debug mode (--inspect-brk instead of --inspect)
dksf-dev run --debug
```

| Option      | Description                                                           |
| ----------- | --------------------------------------------------------------------- |
| `--debug`   | Use `--inspect-brk` instead of `--inspect`                            |
| `<script>`  | Entrypoint to run (default: `.`, resolves via `main` in package.json) |
| `-- <args>` | Arguments passed to the child process (default: `server:start`)       |

**Inspect port**: Always includes `--inspect` (or `--inspect-brk` with `--debug`). If `PORT` is set, the inspect port is `PORT + 1000`. Otherwise the default Node.js inspect port (9229) is used.

**Multi-process coordination**: Multiple `dksf-dev run` processes in the same project coordinate via a temp file (keyed by a hash of the project path). The first process performs the clean+build; any others started concurrently wait for it to finish. This allows running multiple dev processes without redundant builds:

```bash
# Terminal 1
dksf-dev run

# Terminal 2 (waits for Terminal 1's build, then starts)
dksf-dev run -- nats:process
```

#### `dksf-dev migrate`

Runs database migrations:

```bash
dksf-dev migrate
dksf-dev migrate --debug
```

If a `dksf-dev run` process is already running (detected via the coordination state file), the clean+build step is skipped. Otherwise, a full clean+build is performed first.

Runs: `node --inspect=9226 . migration:run` (or `--inspect-brk=9226` with `--debug`).

#### `dksf-dev migrate:create`

Generates a migration by comparing entity definitions against the live database:

```bash
dksf-dev migrate:create
dksf-dev migrate:create --debug
dksf-dev migrate:create --non-interactive
```

Builds (if needed), then runs `node --inspect=9226 . migration:create`. Extra arguments (e.g., `--non-interactive`) are passed through.

#### `dksf-dev migrate:reset`

Removes all existing migrations and generates a single base migration from entity definitions:

```bash
dksf-dev migrate:reset
dksf-dev migrate:reset --debug
```

Builds (if needed), then runs `node --inspect=9226 . migration:reset`.

#### `dksf-dev migrate:charset`

Standardizes character set and collation for all tables (MySQL-only):

```bash
dksf-dev migrate:charset
dksf-dev migrate:charset --debug
dksf-dev migrate:charset utf8mb4 utf8mb4_0900_ai_ci
```

Builds (if needed), then runs `node --inspect=9226 . migration:charset`. Extra arguments (charset, collation) are passed through.

#### `dksf-dev test`

Cleans, compiles tests, and runs the test suite:

```bash
# Run all tests
dksf-dev test

# Run specific test file(s)
dksf-dev test tests/helpers/array.spec.ts

# Run all tests in a directory
dksf-dev test tests/integration/

# Debug mode
dksf-dev test --debug
```

Runs: `tsc -p tsconfig.test.json`, then `dksf-test` with `--inspect=9268` (or `--inspect-brk=9268` with `--debug`). Extra arguments are passed through to `dksf-test`.

#### `dksf-dev repl`

Builds (if no `dksf-dev run` process is active) and starts an interactive REPL:

```bash
# Start REPL
dksf-dev repl

# Debug mode
dksf-dev repl --debug
```

Runs: `node --inspect=9227 . repl` (or `--inspect-brk=9227` with `--debug`). See [REPL](#repl) above for usage inside the REPL.

### `dksf-gen-proto`

Generate TypeScript types from Protocol Buffer `.proto` files using ts-proto:

```bash
dksf-gen-proto <input.proto> <output-dir> [options]
```

| Option           | Description                        |
| ---------------- | ---------------------------------- |
| `--use-date`     | Use `Date` instead of `Timestamp`  |
| `--use-map-type` | Use `Map` instead of plain objects |
| `--only-types`   | Generate only type definitions     |

Example:

```bash
dksf-gen-proto src/proto/messages.proto src/generated/proto/messages
```

### `dksf-install`

Postinstall script that runs:

1. `patch-package` -- Apply any patches
2. `deepkit-type-install` -- Install Deepkit type reflection

This runs automatically after `npm install` / `yarn install`.

### `dksf-update`

Update utility for the library.

## Creating Migrations

Migrations are TypeScript files in the `src/migrations/` directory (or `dist/migrations/` or `dist/src/migrations/` for compiled code):

```typescript
// src/migrations/20240101_120000_add_users.ts
import { createMigration } from '@zyno-io/dk-server-foundation';

export default createMigration(async db => {
    await db.rawExecute(sql`
        CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            name VARCHAR(255) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
});
```

Run programmatically:

```typescript
import { runMigrations } from '@zyno-io/dk-server-foundation';
await runMigrations();
```

## Migration File Resolution

- Running `.ts` files: looks in `src/migrations/`
- Running `.js` files: looks in `dist/migrations/` or `dist/src/migrations/`
- Override with `DKSF_FORCE_DIST_MIGRATIONS=true` to always use `dist/`
