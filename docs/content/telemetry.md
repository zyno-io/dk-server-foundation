# Telemetry

OpenTelemetry auto-instrumentation and Sentry error tracking.

## OpenTelemetry Setup

Call `init()` **before** other imports to enable auto-instrumentation:

```typescript
import { init } from '@signal24/dk-server-foundation/telemetry/otel';

init();

// Now import everything else
import { createApp } from '@signal24/dk-server-foundation';
```

### `init(options?)`

| Option                             | Type                                          | Description                               |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `instrumentations`                 | `Instrumentation[]`                           | Additional OpenTelemetry instrumentations |
| `httpIncomingRequestAttributeHook` | `(request) => Record<string, AttributeValue>` | Add custom attributes to HTTP spans       |
| `enableMetricsEndpoint`            | `boolean`                                     | Enable `/metrics` Prometheus endpoint     |

### Built-in Instrumentations

| Instrumentation | Package                                  | Notes                                      |
| --------------- | ---------------------------------------- | ------------------------------------------ |
| HTTP            | `@opentelemetry/instrumentation-http`    | Ignores `/healthz` and Sentry requests     |
| Undici (fetch)  | `@opentelemetry/instrumentation-undici`  | Ignores `/healthz` and Sentry requests     |
| DNS             | `@opentelemetry/instrumentation-dns`     | —                                          |
| ioredis         | `@opentelemetry/instrumentation-ioredis` | —                                          |
| BullMQ          | `@opentelemetry/instrumentation-bullmq`  | —                                          |
| MariaDB         | Custom                                   | Traces queries and connection pool metrics |

### Trace Export

- **Development**: `SimpleSpanProcessor` (immediate export)
- **Production**: `BatchSpanProcessor` (buffered export)

### Metric Export

- **Pull**: `/metrics` endpoint (Prometheus format, restricted to private IPs)
- **Push**: OTLP endpoint with 10-second interval

### Database Transaction Tracing

The library automatically wraps `Database.prototype.transaction` to create spans named `sql.transaction`.

## Tracing Helpers

```typescript
import { withSpan, withRootSpan, withRemoteSpan, setSpanAttributes } from '@signal24/dk-server-foundation';

// Create a child span
const result = await withSpan('processOrder', async () => {
    return await doWork();
});

// With attributes
const result = await withSpan('processOrder', { orderId: '123' }, async () => {
    return await doWork();
});

// Create a root span (ignores current context)
const result = await withRootSpan('backgroundJob', async () => {
    return await doWork();
});

// Continue a trace from a remote context
const result = await withRemoteSpan('handleRequest', { traceparent: '00-abc...' }, undefined, async () => {
    return await doWork();
});

// Add attributes to the active span
setSpanAttributes({ 'user.id': userId, 'order.total': total });
```

### State Inspection

```typescript
import { isTracingInstalled, getTracer, getActiveSpan, getTraceContext, disableActiveTrace } from '@signal24/dk-server-foundation';

if (isTracingInstalled()) {
    const tracer = getTracer();
    const span = getActiveSpan();
    const context = getTraceContext(); // { traceId, spanId, traceFlags }
}

// Suppress tracing for a section
disableActiveTrace();
```

### `SpanInfo`

Remote span context for `withRemoteSpan`:

```typescript
type SpanInfo = { traceId: string; spanId: string; traceFlags?: number } | { traceparent: string } | undefined;
```

## Sentry

Sentry functions are available from the `telemetry/sentry` subpath (not re-exported from the package root):

```typescript
import { installSentry, isSentryInstalled, flushSentry } from '@signal24/dk-server-foundation/telemetry/sentry';

installSentry({ dsn: 'https://...' });

// Check if installed
if (isSentryInstalled()) {
    /* ... */
}

// Flush pending events (5s timeout)
await flushSentry();
```

Sentry is automatically installed by `createApp()` when `SENTRY_DSN` is configured. It integrates with OpenTelemetry tracing (adds trace context to Sentry events).

### Automatic Error Handling

`createApp()` sets up handlers for `uncaughtException` and `unhandledRejection` that report to Sentry and flush before exit.

## MariaDB Instrumentation

Custom OpenTelemetry instrumentation for the `mariadb` package:

- Wraps `createConnection`, `createPool`, `createPoolCluster`
- Creates spans for each SQL query
- Tracks connection pool metrics via `db.client.connections.usage` counter
- Reports `idle` and `used` connection states

## Metrics Endpoint

The `/metrics` endpoint serves Prometheus-formatted metrics. It is:

- Restricted to private LAN IPs (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, fc00::/7, fe80::/10)
- Returns 403 for non-private IPs
- Returns 503 if the Prometheus exporter is not available

## Configuration

| Variable                              | Description                           |
| ------------------------------------- | ------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | OTLP endpoint for traces and metrics  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | OTLP endpoint for traces only         |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | OTLP endpoint for metrics push        |
| `OTEL_METRICS_ENDPOINT_ENABLED`       | Enable `/metrics` Prometheus endpoint |
| `OTEL_DEBUG`                          | Enable debug logging                  |
| `SENTRY_DSN`                          | Sentry DSN                            |
| `APP_ENV`                             | Environment name sent to Sentry       |

### Resource Attributes

Traces and metrics include:

| Attribute                     | Source          |
| ----------------------------- | --------------- |
| `service.name`                | Package name    |
| `service.version`             | Package version |
| `deployment.environment.name` | `APP_ENV`       |
| `host.name`                   | OS hostname     |
| `process.pid`                 | Process ID      |
