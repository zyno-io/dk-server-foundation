# Documentation

## Getting Started

| Document                                | Description                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Getting Started](./getting-started.md) | Installation, app creation with `createApp()`, AutoStart, dependency resolution, and environment detection. |
| [Configuration](./configuration.md)     | Full reference for all built-in environment variables: database, auth, Redis, mail, telemetry, and more.    |

## Core

| Document                              | Description                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Database](./database.md)             | MySQL/MariaDB ORM with transactions, hooks, session locks, raw queries, entity creation, dirty tracking, relationship resolution, and migrations. |
| [HTTP](./http.md)                     | Custom HTTP kernel, middleware, CORS, error handling, file uploads, response helpers, and request-scoped caching.                                 |
| [Authentication](./authentication.md) | JWT (HS256/EdDSA) and HTTP Basic Auth with entity resolution, password hashing, and reset tokens.                                                 |
| [Logging](./logging.md)               | Scoped Pino logger with async context tracking, structured data, and error reporting integration.                                                 |
| [Health Checks](./health.md)          | Extensible health check service with `/healthz` endpoint and automatic database health monitoring.                                                |
| [Types](./types.md)                   | Custom validated types: phone numbers, dates, coordinates, emails, trimmed strings, and utility types.                                            |

## Services

| Document                              | Description                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Workers](./worker.md)                | BullMQ background job processing with `@WorkerJob()` decorator, cron scheduling, and job lifecycle observer.                                                                           |
| [SRPC](./srpc.md)                     | Bidirectional WebSocket RPC with HMAC auth, ts-proto code generation, multiplexed binary streams, and tracing.                                                                         |
| [Leader Service](./leader-service.md) | Distributed leader election via Redis. One instance holds the lock at a time, with TTL-based expiry, automatic renewal, and callbacks for leadership transitions.                      |
| [Mesh Service](./mesh-service.md)     | Typed RPC between distributed instances. Nodes register handlers and invoke them across the mesh by instance ID, with automatic heartbeats, timeout management, and dead-node cleanup. |
| [Mail](./mail.md)                     | Email sending via Postmark or SMTP with a template system.                                                                                                                             |

## Utilities

| Document                    | Description                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Helpers](./helpers.md)     | Async context, Redis cache/mutex/broadcast, cryptography, data manipulation, transformers, process execution, and more.                |
| [Telemetry](./telemetry.md) | OpenTelemetry auto-instrumentation for HTTP, database, Redis, DNS, BullMQ, and Sentry error tracking.                                  |
| [Testing](./testing.md)     | Test facades with per-test database isolation, entity fixtures, mock requests, and SQL mocking.                                        |
| [DevConsole](./devconsole.md) | Built-in web dashboard for development: HTTP inspector, SRPC monitor, database browser, REPL, worker/mutex/health views, and more.    |
| [CLI Tools](./cli.md)       | `dksf-dev` workflow (clean/build/run/migrate/test), REPL, provider invoke, migration commands, proto generation, and standalone tools. |
