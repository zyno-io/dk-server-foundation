# Configuration

Configuration is managed via `BaseAppConfig`, which uses `@signal24/config` to load values from environment variables. Extend it with your own properties.

```typescript
import { BaseAppConfig } from '@signal24/dk-server-foundation';

class AppConfig extends BaseAppConfig {
    STRIPE_KEY_SECRET!: string;
    MAX_UPLOAD_SIZE: number = 10_000_000;
}
```

Properties ending in `_SECRET` are treated as secrets by the config loader.

## Built-in Configuration

### Application

| Variable  | Type     | Default | Description                                                 |
| --------- | -------- | ------- | ----------------------------------------------------------- |
| `APP_ENV` | `string` | —       | Application environment (`development`, `production`, etc.) |
| `PORT`    | `number` | `3000`  | HTTP server port                                            |

### MySQL Database

| Variable                     | Type     | Default             | Description              |
| ---------------------------- | -------- | ------------------- | ------------------------ |
| `MYSQL_HOST`                 | `string` | —                   | Database host            |
| `MYSQL_PORT`                 | `number` | —                   | Database port            |
| `MYSQL_USER`                 | `string` | —                   | Database user            |
| `MYSQL_PASSWORD_SECRET`      | `string` | —                   | Database password        |
| `MYSQL_DATABASE`             | `string` | —                   | Database name            |
| `MYSQL_CONNECTION_LIMIT`     | `number` | 10 (prod) / 5 (dev) | Max pool connections     |
| `MYSQL_MIN_IDLE_CONNECTIONS` | `number` | — (prod) / 1 (dev)  | Minimum idle connections |
| `MYSQL_IDLE_TIMEOUT_SECONDS` | `number` | 60 (prod) / 5 (dev) | Idle connection timeout  |

### JWT Authentication

| Variable                   | Type      | Default | Description                             |
| -------------------------- | --------- | ------- | --------------------------------------- |
| `AUTH_JWT_ISSUER`          | `string`  | —       | JWT issuer claim                        |
| `AUTH_JWT_EXPIRATION_MINS` | `number`  | —       | Token expiration in minutes             |
| `AUTH_JWT_COOKIE_NAME`     | `string`  | —       | Cookie name for JWT storage             |
| `AUTH_JWT_SECRET`          | `string`  | —       | HMAC secret (plain string)              |
| `AUTH_JWT_SECRET_B64`      | `string`  | —       | HMAC secret (base64-encoded)            |
| `AUTH_JWT_ED_SECRET`       | `string`  | —       | EdDSA private key (PEM, base64-encoded) |
| `AUTH_JWT_ENABLE_VERIFY`   | `boolean` | `true`  | Enable JWT signature verification       |

### Basic Authentication

| Variable            | Type     | Default | Description                  |
| ------------------- | -------- | ------- | ---------------------------- |
| `AUTH_BASIC_SECRET` | `string` | —       | Password for HTTP Basic Auth |

### Cryptography

| Variable           | Type     | Default | Description                                   |
| ------------------ | -------- | ------- | --------------------------------------------- |
| `CRYPTO_SECRET`    | `string` | —       | 32-byte key (or 64 hex chars) for AES-256-GCM |
| `CRYPTO_IV_LENGTH` | `number` | `12`    | IV length for AES-GCM                         |

### HTTP

| Variable                         | Type      | Default | Description                                     |
| -------------------------------- | --------- | ------- | ----------------------------------------------- |
| `USE_REAL_IP_HEADER`             | `boolean` | —       | Trust `x-real-ip` header from reverse proxy     |
| `HTTP_REQUEST_LOGGING_MODE`      | `string`  | `e2e`   | Logging mode: `none`, `e2e`, `finish`, `errors` |
| `HEALTHZ_ENABLE_REQUEST_LOGGING` | `boolean` | `false` | Log healthcheck requests                        |

### Redis

All Redis configurations support both direct connection and Sentinel mode. The library uses separate Redis instances for different concerns:

#### Default Redis

| Variable              | Description                             |
| --------------------- | --------------------------------------- |
| `REDIS_HOST`          | Redis host                              |
| `REDIS_PORT`          | Redis port                              |
| `REDIS_PREFIX`        | Key prefix (falls back to package name) |
| `REDIS_SENTINEL_HOST` | Sentinel host                           |
| `REDIS_SENTINEL_PORT` | Sentinel port                           |
| `REDIS_SENTINEL_NAME` | Sentinel master name                    |

#### Cache Redis (`CACHE_REDIS_` prefix)

Used by the `Cache` class. Falls back to default Redis settings.

#### Broadcast Redis (`BROADCAST_REDIS_` prefix)

Used by `createBroadcastChannel()` and `createDistributedMethod()`. Falls back to default Redis settings.

#### BullMQ Redis (`BULL_REDIS_` prefix)

Used by the worker system. Falls back to default Redis settings.

| Variable     | Type     | Default   | Description               |
| ------------ | -------- | --------- | ------------------------- |
| `BULL_QUEUE` | `string` | `default` | Default BullMQ queue name |

#### Mesh Redis (`MESH_REDIS_` prefix)

Used by `MeshService`. Falls back to default Redis settings.

#### Mutex Redis (`MUTEX_REDIS_` prefix)

Used by `withMutex()` and `LeaderService`. Falls back to default Redis settings.

| Variable     | Type     | Default | Description                                 |
| ------------ | -------- | ------- | ------------------------------------------- |
| `MUTEX_MODE` | `string` | `local` | Mutex mode: `local` (in-process) or `redis` |

### Mail

| Variable               | Type      | Default     | Description                         |
| ---------------------- | --------- | ----------- | ----------------------------------- |
| `MAIL_PROVIDER`        | `string`  | `smtp`      | Mail provider: `smtp` or `postmark` |
| `MAIL_FROM`            | `string`  | —           | Sender email address                |
| `MAIL_FROM_NAME`       | `string`  | —           | Sender display name                 |
| `SMTP_HOST`            | `string`  | `127.0.0.1` | SMTP server host                    |
| `SMTP_PORT`            | `number`  | `1025`      | SMTP server port                    |
| `SMTP_USER`            | `string`  | —           | SMTP username                       |
| `SMTP_PASSWORD_SECRET` | `string`  | —           | SMTP password                       |
| `SMTP_TLS`             | `boolean` | `false`     | Enable TLS                          |
| `POSTMARK_SECRET`      | `string`  | —           | Postmark API token                  |

### Workers

| Variable              | Type      | Default      | Description                   |
| --------------------- | --------- | ------------ | ----------------------------- |
| `ENABLE_JOB_RUNNER`   | `boolean` | `true` (dev) | Enable BullMQ job runner      |
| `ENABLE_JOB_OBSERVER` | `boolean` | `true` (dev) | Enable job lifecycle observer |

### Observability

| Variable                              | Type      | Default | Description                           |
| ------------------------------------- | --------- | ------- | ------------------------------------- |
| `SENTRY_DSN`                          | `string`  | —       | Sentry DSN for error tracking         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | `string`  | —       | OTLP endpoint for traces and metrics  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | `string`  | —       | OTLP endpoint for traces only         |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `string`  | —       | OTLP endpoint for metrics push        |
| `OTEL_METRICS_ENDPOINT_ENABLED`       | `boolean` | —       | Enable `/metrics` Prometheus endpoint |
| `OTEL_DEBUG`                          | `boolean` | —       | Enable debug logging                  |
| `ALERTS_SLACK_WEBHOOK_URL`            | `string`  | —       | Slack webhook for alert-level errors  |

### SRPC

| Variable                   | Type     | Default | Description                         |
| -------------------------- | -------- | ------- | ----------------------------------- |
| `SRPC_AUTH_SECRET`         | `string` | —       | HMAC secret for SRPC authentication |
| `SRPC_AUTH_CLOCK_DRIFT_MS` | `number` | `30000` | Allowed clock drift for SRPC auth   |

### OpenAPI

| Variable                | Type      | Default | Description                           |
| ----------------------- | --------- | ------- | ------------------------------------- |
| `ENABLE_OPENAPI_SCHEMA` | `boolean` | —       | Dump OpenAPI schema to `openapi.yaml` |

## `isDevFeatureEnabled(envVar, defaultInDev?)`

Helper function to check if a feature flag is enabled. Returns `true` in development/Jest by default.

```typescript
import { isDevFeatureEnabled } from '@signal24/dk-server-foundation';

if (isDevFeatureEnabled(config.MY_FEATURE)) {
    // enabled
}
```

| Input              | Production | Development      |
| ------------------ | ---------- | ---------------- |
| `undefined`        | `false`    | `true` (default) |
| `'1'` or `'true'`  | `true`     | `true`           |
| `'0'` or `'false'` | `false`    | `false`          |
