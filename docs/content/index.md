---
layout: home

hero:
  name: "@signal24/dk-server-foundation"
  text: "Server Foundation Library"
  tagline: TypeScript foundation library built on Deepkit for building robust server applications
  image:
    src: /images/devconsole/01-dashboard.png
    alt: DevConsole Dashboard
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/signal24/dk-server-foundation

features:
  - icon: 🗄️
    title: Database ORM
    details: MySQL/PostgreSQL support with transactions, hooks, session locks, and automatic migrations
  - icon: 🌐
    title: HTTP Server
    details: Custom HTTP kernel with middleware, CORS, file uploads, and OpenAPI documentation
  - icon: 🔐
    title: Authentication
    details: JWT (HS256/EdDSA) and HTTP Basic Auth with entity resolution and password hashing
  - icon: ⚙️
    title: Background Workers
    details: BullMQ-based job processing with decorators, cron scheduling, and lifecycle observers
  - icon: 🔌
    title: WebSocket RPC
    details: Bidirectional SRPC with HMAC auth, ts-proto code generation, and binary streams
  - icon: 📊
    title: Telemetry
    details: OpenTelemetry auto-instrumentation for HTTP, database, Redis, DNS, and BullMQ
  - icon: 🏥
    title: Health Checks
    details: Extensible health check service with automatic database monitoring
  - icon: 🛠️
    title: DevConsole
    details: Built-in web dashboard for development with HTTP inspector, REPL, and more
  - icon: 📧
    title: Mail Service
    details: Email sending via Postmark or SMTP with template system
  - icon: 🔒
    title: Distributed Systems
    details: Leader election and mesh networking for coordinated multi-instance deployments
  - icon: 🧪
    title: Testing Utilities
    details: Test facades with per-test database isolation, fixtures, and request mocking
  - icon: 📝
    title: Comprehensive Logging
    details: Scoped Pino logger with async context tracking and structured data
---

## Quick Start

```bash
npm install @signal24/dk-server-foundation
# or
yarn add @signal24/dk-server-foundation
```

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

## DevConsole Screenshots

The built-in DevConsole provides a comprehensive development dashboard:

### Dashboard
![DevConsole Dashboard](/images/devconsole/01-dashboard.png)

### Routes
![DevConsole Routes](/images/devconsole/02-routes.png)

### OpenAPI Schema
![DevConsole OpenAPI](/images/devconsole/03-openapi.png)

### HTTP Requests
![DevConsole Requests](/images/devconsole/04-requests.png)

### SRPC
![DevConsole SRPC](/images/devconsole/05-srpc.png)

### Database
![DevConsole Database](/images/devconsole/06-database.png)

### Health Checks
![DevConsole Health](/images/devconsole/07-health.png)

### Mutex Monitor
![DevConsole Mutex](/images/devconsole/08-mutex.png)

### Interactive REPL
![DevConsole REPL](/images/devconsole/09-repl.png)

### Workers
![DevConsole Workers](/images/devconsole/10-workers.png)

## Features at a Glance

- **Application Factory**: `createApp()` sets up Deepkit with opinionated defaults
- **Configuration**: Environment-based config with `@signal24/config` integration
- **Database**: Extends Deepkit ORM with MySQL/PostgreSQL support, transaction hooks, and session locks
- **HTTP**: Custom kernel with middleware, CORS, uploads, and error handling
- **Workers**: BullMQ background job processing with `@WorkerJob()` decorator
- **SRPC**: Bidirectional WebSocket RPC with HMAC authentication
- **Leader Election**: Redis-based distributed leader election for single-instance tasks
- **Mesh Networking**: Typed RPC between distributed application instances
- **Mail**: Email via Postmark or SMTP with template system
- **Telemetry**: OpenTelemetry and Sentry integration
- **Testing**: Comprehensive test utilities and fixtures
- **CLI Tools**: REPL, provider invoke, migration commands, and more

## License

MIT License - see [LICENSE](https://github.com/signal24/dk-server-foundation/blob/main/LICENSE) for details.
