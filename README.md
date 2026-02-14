# @signal24/dk-server-foundation

A TypeScript foundation library built on top of the [Deepkit framework](https://deepkit.io) for building server applications. Provides opinionated abstractions and utilities for database management, HTTP handling, authentication, background jobs, RPC, distributed systems, and observability.

📚 **[Documentation Site](https://signal24.github.io/dk-server-foundation/)** | 🚀 **[Getting Started](./docs/getting-started.md)**

## Install

```bash
npm install @signal24/dk-server-foundation
# or
yarn add @signal24/dk-server-foundation
```

The postinstall script runs `deepkit-type-install` and `patch-package` automatically.

> **Requirement:** TypeScript with `experimentalDecorators: true` and Deepkit's `"reflection": true` in tsconfig.json.

## Quick Start

```typescript
import { createApp, BaseAppConfig, createMySQLDatabase } from '@signal24/dk-server-foundation';

class AppConfig extends BaseAppConfig {
    MY_SETTING!: string;
}

class MyDB extends createMySQLDatabase({}, [UserEntity]) {}

const app = createApp({
    config: AppConfig,
    db: MyDB,
    cors: config => ({ hosts: ['https://example.com'], credentials: true }),
    controllers: [UserController],
    providers: [UserService]
});

app.run();
```

This gives you an HTTP server on port 3000 with health checks, CORS, database, logging, and OpenAPI docs (in development).

## Modules

| Module                                  | Description                                                | Docs                                         |
| --------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| [Application](#application)             | App factory, config, DI resolution                         | [Getting Started](./docs/getting-started.md) |
| [Graceful Shutdown](#graceful-shutdown) | Pre-shutdown event for async cleanup                       |                                              |
| [Configuration](#configuration)         | Environment-based config with secrets support              | [Configuration](./docs/configuration.md)     |
| [Database](#database)                   | MySQL/MariaDB ORM with transactions, hooks, and migrations | [Database](./docs/database.md)               |
| [HTTP](#http)                           | Custom HTTP kernel, middleware, uploads, CORS              | [HTTP](./docs/http.md)                       |
| [Authentication](#authentication)       | JWT and Basic Auth with entity resolution                  | [Authentication](./docs/authentication.md)   |
| [Workers](#workers)                     | BullMQ background job processing                           | [Workers](./docs/worker.md)                  |
| [SRPC](#srpc)                           | Bidirectional WebSocket RPC with binary streams            | [SRPC](./docs/srpc.md)                       |
| [Leader Election](#leader-election)     | Redis-based distributed leader election                    | [Leader Service](./docs/leader-service.md)   |
| [Mesh Networking](#mesh-networking)     | Typed RPC between distributed instances                    | [Mesh Service](./docs/mesh-service.md)       |
| [Mail](#mail)                           | Email via Postmark or SMTP with templates                  | [Mail](./docs/mail.md)                       |
| [Telemetry](#telemetry)                 | OpenTelemetry and Sentry integration                       | [Telemetry](./docs/telemetry.md)             |
| [Health Checks](#health-checks)         | Liveness endpoint with pluggable checks                    | [Health](./docs/health.md)                   |
| [Helpers](#helpers)                     | Async context, Redis cache/mutex, crypto, and more         | [Helpers](./docs/helpers.md)                 |
| [Testing](#testing)                     | Test facades, fixtures, and request mocking                | [Testing](./docs/testing.md)                 |
| [Types](#types)                         | Phone numbers, dates, coordinates, and utility types       | [Types](./docs/types.md)                     |
| [Logging](#logging)                     | Scoped Pino logger with context tracking                   | [Logging](./docs/logging.md)                 |
| [DevConsole](#devconsole)               | Built-in web dashboard for development monitoring          | [DevConsole](./docs/devconsole.md)           |
| [CLI Tools](#cli-tools)                 | REPL, provider invoke, migrations, proto generation        | [CLI](./docs/cli.md)                         |

---

## Application

Applications are created with `createApp()`, which sets up a Deepkit app with opinionated defaults: custom HTTP kernel, health checks, config loading from environment variables, CORS, and optional worker/RPC support.

```typescript
const app = createApp({
    config: MyConfig,
    db: MyDB,
    enableWorker: true,
    cors: config => ({ hosts: [config.CORS_ORIGIN], credentials: true })
});
```

Services decorated with `@AutoStart()` are instantiated at startup for establishing connections or background processes.

Use `resolve()` (or its alias `r()`) to access any provider from the DI container outside of constructor injection:

```typescript
import { r } from '@signal24/dk-server-foundation';
const db = r(MyDatabase);
```

## Graceful Shutdown

`createApp()` automatically installs a `ShutdownListener` that intercepts SIGTERM/SIGINT and dispatches an `onServerShutdownRequested` event before forwarding to Deepkit's built-in shutdown. This lets you perform async cleanup (drain connections, finish in-flight work) before the framework tears down.

```typescript
import { eventDispatcher } from '@deepkit/event';
import { onServerShutdownRequested } from '@signal24/dk-server-foundation';

class MyShutdownHandler {
    @eventDispatcher.listen(onServerShutdownRequested)
    async onShutdownRequested() {
        // Async cleanup here — this handler is awaited before
        // Deepkit's onServerShutdown fires.
    }
}
```

Register your handler as a listener in `createApp()`:

```typescript
const app = createApp({
    config: AppConfig,
    listeners: [MyShutdownHandler]
});
```

## Configuration

Extend `BaseAppConfig` to define application settings. All properties are loaded from environment variables via `@signal24/config`. Properties ending in `_SECRET` are treated as secrets.

```typescript
class AppConfig extends BaseAppConfig {
    STRIPE_API_KEY_SECRET!: string;
    MAX_UPLOAD_SIZE: number = 10_000_000;
}
```

See [Configuration](./docs/configuration.md) for the full list of built-in settings.

## Database

Extends Deepkit's ORM with support for both **MySQL** and **PostgreSQL**: transaction hooks, session locks, raw query helpers, and entity creation utilities.

```typescript
class MyDB extends createMySQLDatabase({}, [User, Post]) {}
// or
class MyDB extends createPostgresDatabase({}, [User, Post]) {}

// Entity creation
const user = await createPersistedEntity(User, { email: 'a@b.com', name: 'Alice' }, session);

// Transaction with hooks
await db.transaction(async session => {
    session.addPostCommitHook(async () => {
        await notifyUser(user);
    });
    await session.flush();
});

// Session locks (MySQL: _locks table, PostgreSQL: pg_advisory_xact_lock)
await db.transaction(async session => {
    await session.acquireSessionLock(['wallet', walletId]);
    // Lock held until commit/rollback
});
```

### Migrations

Generate migrations by diffing entity definitions against the live database:

```bash
# Interactive mode (prompts for column renames)
ts-node app.ts migration:create

# Non-interactive (CI-safe, treats ambiguous changes as drop+add)
ts-node app.ts migration:create --non-interactive

# Run pending migrations
ts-node app.ts migration:run
```

The `migration:create` command reads entity metadata via Deepkit reflection, introspects the database schema, and generates dialect-appropriate DDL covering: table creation/removal, column additions/removals/modifications/renames, index and foreign key changes, primary key changes, and PostgreSQL enum type management. Migration files use the `createMigration()` format:

```typescript
import { createMigration } from '@signal24/dk-server-foundation';

export default createMigration(async db => {
    await db.rawExecute(`ALTER TABLE \`users\` ADD COLUMN \`bio\` varchar(500) NULL AFTER \`email\``);
});
```

## HTTP

Custom HTTP kernel with configurable request logging, middleware that preserves HTTP error codes, file uploads, and multi-origin CORS support.

```typescript
// Custom middleware
class RateLimitMiddleware extends HttpMiddleware {
    async handle(request: HttpRequest, response: HttpResponse) {
        // Rate limiting logic; throw HttpError to reject
    }
}
```

Response type helpers (`OkResponse`, `RedirectResponse`, `EmptyResponse`, `AnyResponse`) are used as return type annotations on controller methods.

## Authentication

JWT (HS256/EdDSA) and HTTP Basic Auth with request-scoped caching and entity resolution.

```typescript
// Create auth middleware that validates JWT and checks entity existence
const authMiddleware = createAuthMiddleware(User);

// Use as route middleware
@http.GET('/me').use(authMiddleware)
async getMe(/* ... */) {
    // JWT is validated; use getEntityFromRequestJwt to load the entity
}
```

## Workers

BullMQ-based background job processing. Define jobs with `@WorkerJob()` and queue them via `WorkerService`.

```typescript
@WorkerJob()
class SendEmailJob extends BaseJob<{ to: string; body: string }, void> {
    async handle(data: { to: string; body: string }) {
        await sendEmail(data.to, data.body);
    }
}

// Queue a job
await workerService.queueJob(SendEmailJob, { to: 'user@example.com', body: 'Hello' });
```

Enable with `enableWorker: true` in `createApp()`. Jobs are automatically discovered and registered.

## SRPC

Bidirectional RPC over WebSocket with HMAC authentication, ts-proto code generation, and multiplexed binary streams.

```typescript
// Server
const server = new SrpcServer({ logger, clientMessage, serverMessage, wsPath: '/rpc' });
server.registerMessageHandler('uEcho', async (stream, data) => {
    return { message: data.message };
});

// Client
const client = new SrpcClient(logger, 'wss://host/rpc', clientMessage, serverMessage, 'client-1');
const result = client.invoke('uEcho', { message: 'hello' });
```

Generate TypeScript types from `.proto` files:

```bash
dksf-gen-proto input.proto output/
```

## Leader Election

Distributed leader election using Redis. Exactly one instance holds leadership at a time, with automatic renewal and failover.

```typescript
const leader = new LeaderService('my-task');
leader.setBecameLeaderCallback(async () => {
    /* start leader-only work */
});
leader.start();
```

See [Leader Service](./docs/leader-service.md) for full API documentation.

## Mesh Networking

Typed RPC between distributed application instances. Nodes get unique IDs and can invoke handlers on any other node with full type safety.

```typescript
type Messages = {
    getStatus: { request: {}; response: { status: string } };
};

const mesh = new MeshService<Messages>('my-app');
mesh.registerHandler('getStatus', async () => ({ status: 'ok' }));
await mesh.start();
```

See [Mesh Service](./docs/mesh-service.md) for full API documentation.

## Mail

Email sending via Postmark or SMTP with a template system.

```typescript
class WelcomeEmail extends MailTemplate<{ name: string }> {
    subject = 'Welcome!';
    generateHtml() {
        return `<h1>Hello ${this.data.name}</h1>`;
    }
}

await mailService.sendFromTemplate({
    to: { address: 'user@example.com' },
    template: WelcomeEmail,
    data: { name: 'Alice' }
});
```

## Telemetry

OpenTelemetry auto-instrumentation for HTTP, database, Redis, DNS, and BullMQ. Optional Sentry integration.

```typescript
// Call before other imports
import { init } from '@signal24/dk-server-foundation/telemetry/otel';
init();

// Manual spans
import { withSpan } from '@signal24/dk-server-foundation';
await withSpan('processOrder', async () => {
    // traced operation
});
```

## Health Checks

A `/healthz` endpoint is automatically registered by `createApp()`. Register additional checks via `HealthcheckService.register()`. When a database is configured, a connectivity check is added automatically.

```typescript
class MyService {
    constructor(private hcSvc: HealthcheckService) {
        hcSvc.register(async () => {
            // Throw to indicate unhealthy
            await checkExternalDependency();
        }, 'External API');
    }
}
```

Use `checkIndividual()` for per-check status results (used by DevConsole's Health view).

## Helpers

Organized utility functions for common patterns:

- **Async**: `AsyncContext`, semaphores, child process execution
- **Redis**: Cache with TTL, distributed mutex, pub/sub broadcast channels
- **Crypto**: AES-256-GCM encryption, random string generation
- **Data**: Array/object manipulation, chainable `Transformer` pipelines
- **Framework**: Deepkit decorator utilities, event handler inheritance

```typescript
// Distributed mutex
await withMutex({
    key: 'user:123',
    fn: async () => {
        /* critical section */
    }
});

// Redis cache
await Cache.setObj('key', data, 3600);
const data = await Cache.getObj<MyType>('key');

// Broadcast
const channel = createBroadcastChannel<MyEvent>('events');
channel.subscribe(data => handleEvent(data));
channel.publish({ type: 'update' });
```

## Testing

Test facades with per-test database isolation, entity fixtures, and request mocking.

```typescript
const tf = TestingHelpers.createTestingFacade(app, {
    enableDatabase: true,
    seedData: async facade => {
        await loadEntityFixtures([fixtures.user1, fixtures.user2]);
    }
});

TestingHelpers.installStandardHooks(tf);

it('should return user', async () => {
    const res = await makeMockRequest(tf, 'GET', '/api/users/1', {});
    expect(res.statusCode).toBe(200);
});
```

## Types

Custom validated types for common patterns:

- `DateString` -- MySQL DATE field (`YYYY-MM-DD`)
- `PhoneNumber` / `PhoneNumberNANP` -- Validated phone numbers via libphonenumber
- `Coordinate` -- MySQL POINT geometry
- `EmailAddress` -- Regex-validated email
- `TrimmedString` / `NonEmptyTrimmedString` -- Auto-trimmed during deserialization
- `ValidDate` -- Date that rejects `Invalid Date`

## Logging

Scoped Pino logger with async context tracking and error reporting.

```typescript
const logger = createLogger(this); // or createLogger('MyService')
logger.info('Processing order', { orderId: 123 });
logger.error('Failed to process', err);
```

## CLI Tools

| Command                                      | Description                                              |
| -------------------------------------------- | -------------------------------------------------------- |
| `dksf-dev <cmd>`                             | Dev workflow: clean, build, run, migrate, repl, test     |
| `dksf-gen-proto <input> <output>`            | Generate TypeScript types from .proto files              |
| `dksf-install`                               | Postinstall setup (patch-package + deepkit-type-install) |
| `dksf-update`                                | Update utility                                           |
| `repl`                                       | Interactive REPL with access to all providers            |
| `provider:invoke <provider> <method> [args]` | Invoke any provider method from CLI                      |
| `worker:start`                               | Start both job runner and observer                       |
| `worker:runner`                              | Start just the job runner                                |
| `worker:observer`                            | Start just the job observer                              |
| `worker:queue <jobName> [data]`              | Queue a job by name                                      |
| `migration:create`                           | Generate migration from entity/DB schema diff            |
| `migration:run`                              | Run pending database migrations                          |
| `migration:reset`                            | Reset migrations to a single base migration              |
| `migration:characters [charset] [collation]` | Standardize database character set                       |

## DevConsole

A built-in web dashboard for development-time monitoring and debugging, automatically enabled when `APP_ENV !== 'production'`. Access it at `http://localhost:{PORT}/_devconsole/` — no setup required.

Features include an HTTP request inspector, SRPC connection monitor, database entity browser with SQL editor, worker job inspector, Redis mutex monitor, health check viewer, environment config display, OpenAPI schema viewer, and a live REPL with access to the DI container.

DevConsole is localhost-only and communicates over SRPC/WebSocket for real-time updates. See [DevConsole](./docs/devconsole.md) for details.

A demo app showcasing all features is included:

```bash
yarn demoapp
# then open http://localhost:3000/_devconsole/
```

## Important Notes

- **Timezone**: The server enforces UTC. The entry point throws if `TZ !== UTC`.
- **Identity Maps**: Disabled by default in database sessions for predictable behavior.
- **Development Mode**: When `APP_ENV !== 'production'`, DevConsole is enabled at `/_devconsole/`, connection pools are smaller, and worker runner/observer auto-start.

## Commands

```bash
yarn build          # Clean build
yarn build:dirty    # Quick rebuild
yarn dev            # Watch mode
yarn test           # Run all tests
yarn format         # Lint with oxlint + format with Prettier
```

## Versioning

This library uses **calendar versioning** in the format `YY.MMDD.HHmm` (e.g. `25.0214.1830`). Versions are generated automatically from the CI pipeline timestamp. There are no stability guarantees between releases — pin to a specific version if you need predictability.

## License

MIT. See [LICENSE](./LICENSE) for details.
