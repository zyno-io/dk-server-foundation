# Logging

Scoped Pino logger with async context tracking, structured data, and error reporting integration.

## Creating Loggers

```typescript
import { createLogger } from '@signal24/dk-server-foundation';

// From a class instance (uses class name as scope)
class OrderService {
    private logger = createLogger(this);

    async process() {
        this.logger.info('Processing order');
    }
}

// From a string
const logger = createLogger('PaymentWorker');

// With default data attached to every log
const logger = createLogger(this, { region: 'us-east-1' });
```

## Log Levels

```typescript
logger.debug('Debug message');
logger.info('Info message');
logger.warning('Warning message');
logger.error('Error message');
logger.alert('Alert message');
```

## Structured Data

```typescript
// Attach data to a log entry
logger.info('Order created', { orderId: 123, total: 99.99 });

// Error with context
logger.error('Payment failed', error, { orderId: 123, provider: 'stripe' });
```

## Scoped Loggers

Create child loggers with a scope prefix and optional persistent data:

```typescript
const logger = createLogger(this);

// Child logger with scope
const paymentLogger = logger.scoped('payment');
paymentLogger.info('Processing');
// Output: [OrderService:payment] Processing

// Child logger with persistent data
const orderLogger = logger.scoped('order', { orderId: 123 });
orderLogger.info('Created');
// Every log includes { orderId: 123 }
```

### `setScopeData(data?)`

Update the persistent data attached to a scoped logger:

```typescript
const logger = createLogger(this);
logger.setScopeData({ userId: 456 });
logger.info('Action');
// Includes { userId: 456 }
```

## Async Context

Logger automatically includes async context properties in log entries. This means request IDs, trace IDs, and other context set via `setContextProp()` or `withContextData()` flow into logs automatically.

```typescript
import { withContextData } from '@signal24/dk-server-foundation';

await withContextData({ reqId: 'abc-123' }, async () => {
    logger.info('Handling request');
    // Log includes reqId: 'abc-123'
});
```

### `withLoggerContext(data, fn)`

Add additional logger context for the duration of a function:

```typescript
import { withLoggerContext } from '@signal24/dk-server-foundation';

await withLoggerContext({ jobId: 'job-456' }, async () => {
    logger.info('Processing job');
    // Log includes jobId: 'job-456'
});
```

## Error Handling

When logging errors, the logger automatically:

1. Extracts the error message and stack trace
2. Includes any `cause` chain
3. Reports to the global error reporter (Sentry, Slack) for `error` and `alert` levels

```typescript
try {
    await riskyOperation();
} catch (err) {
    logger.error('Operation failed', err);
    // Error reported to Sentry, details logged to Pino
}
```

## ExtendedLogger

`ExtendedLogger` replaces Deepkit's default `Logger` in the DI container. It extends `Logger` with:

- Pino as the underlying transport
- Scoped child loggers
- Async context integration
- Error reporting to Sentry and Slack

All injected `Logger` instances are `ExtendedLogger` instances.

## Pino Instance

Access the raw Pino logger:

```typescript
import { pinoLogger } from '@signal24/dk-server-foundation';

pinoLogger.info({ custom: 'data' }, 'Raw pino log');
```

## HTTP Request Logging

Request logging is handled by the HTTP kernel and configured via `HTTP_REQUEST_LOGGING_MODE`:

| Mode     | Description                  |
| -------- | ---------------------------- |
| `e2e`    | Log at request start and end |
| `finish` | Log only at request end      |
| `errors` | Log only errors              |
| `none`   | No request logging           |

Health check logging is disabled by default. Enable with `HEALTHZ_ENABLE_REQUEST_LOGGING=true`.
