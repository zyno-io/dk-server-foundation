# Getting Started

## Installation

```bash
npm install @signal24/dk-server-foundation
# or
yarn add @signal24/dk-server-foundation
```

### TypeScript Configuration

Your `tsconfig.json` must enable experimental decorators and Deepkit reflection:

```json
{
    "compilerOptions": {
        "experimentalDecorators": true
    },
    "reflection": true
}
```

## Creating an Application

Use `createApp()` to set up a Deepkit application with opinionated defaults.

```typescript
import { createApp, BaseAppConfig, createMySQLDatabase } from '@signal24/dk-server-foundation';

// 1. Define your config
class AppConfig extends BaseAppConfig {
    STRIPE_KEY_SECRET!: string;
}

// 2. Define your database
class AppDB extends createMySQLDatabase({}, [UserEntity, PostEntity]) {}

// 3. Create and run
const app = createApp({
    config: AppConfig,
    db: AppDB,
    enableWorker: true,
    cors: config => ({
        hosts: ['https://myapp.com'],
        credentials: true
    }),
    controllers: [UserController, PostController],
    providers: [UserService, PostService]
});

app.run();
```

### What `createApp()` Sets Up

- HTTP server on port 3000 (configurable via `PORT`)
- Custom HTTP kernel with request logging
- Health check endpoint at `GET /healthz`
- Multipart form parsing (JSON key: `_payload`)
- REPL and provider invoke CLI commands
- [DevConsole](./devconsole.md) at `/_devconsole/` with request inspector, REPL, database browser, and more (development only)
- Sentry integration (if `SENTRY_DSN` is set)
- Graceful shutdown with 30-second timeout

## `createApp()` Options

```typescript
interface CreateAppOptions<C extends BaseAppConfig> extends RootModuleDefinition {
    config: ClassType<C>;
    defaultConfig?: Partial<C>;
    db?: ClassType<BaseDatabase>;
    frameworkConfig?: Partial<FrameworkConfig>;
    cors?: (config: C) => HttpCorsOptions | HttpCorsOptions[];
    enableWorker?: boolean;
    enableDkRpc?: boolean;
}
```

| Option            | Required | Description                                                                                               |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `config`          | Yes      | Config class extending `BaseAppConfig`. Properties are loaded from environment variables.                 |
| `defaultConfig`   | No       | Default values for config properties.                                                                     |
| `db`              | No       | Database class created via `createMySQLDatabase()`. Registers health check and enables entity management. |
| `frameworkConfig` | No       | Override Deepkit framework settings (debug mode, etc.).                                                   |
| `cors`            | No       | Factory function returning CORS options. Receives the resolved config instance.                           |
| `enableWorker`    | No       | Enable BullMQ worker system. Registers job runner, observer, and CLI commands.                            |
| `enableDkRpc`     | No       | Enable Deepkit's built-in RPC module.                                                                     |

Standard Deepkit `RootModuleDefinition` fields are also accepted: `controllers`, `providers`, `listeners`, `imports`, `exports`, `workflows`, `middlewares`.

## AutoStart Decorator

Services decorated with `@AutoStart()` are instantiated at application startup, before dependency injection requests. Use this for services that need to establish connections or start background processes.

```typescript
import { AutoStart } from '@signal24/dk-server-foundation';

@AutoStart()
class WebSocketManager {
    constructor() {
        // Automatically called at startup
        this.connect();
    }
}
```

## Dependency Resolution

Use `resolve()` (or its alias `r()`) to access providers outside of constructor injection:

```typescript
import { r, resolve, getApp, getAppConfig } from '@signal24/dk-server-foundation';

// Resolve a provider
const db = r(MyDatabase);
const logger = resolve(ExtendedLogger);

// Access the app or config
const app = getApp();
const config = getAppConfig();
```

### `resolveDeep(type, fromModule?)`

Recursively searches through module imports to find a provider. Returns `undefined` if not found.

```typescript
import { resolveDeep } from '@signal24/dk-server-foundation';

const service = resolveDeep(MyService); // searches all modules
```

## Environment Detection

```typescript
import { isDevelopment, isTest } from '@signal24/dk-server-foundation';

if (isDevelopment) {
    // APP_ENV and NODE_ENV are unset or 'development'
}

if (isTest) {
    // Running inside Jest or APP_ENV === 'test'
}
```

## Timezone

The library enforces UTC at startup. If `TZ` is not set to `UTC`, the process will throw an error. Set the environment variable before starting:

```bash
TZ=UTC node app.js
```
