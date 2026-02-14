# Health Checks

Built-in health check system with an extensible service and HTTP endpoint.

## Endpoint

```
GET /healthz
```

Returns:

```json
{ "version": "1.2.3" }
```

The version is read from `package.json`. Returns `"unknown"` if not available.

If any registered health check fails, the endpoint returns an HTTP 500 error.

## Registering Health Checks

```typescript
import { HealthcheckService } from '@signal24/dk-server-foundation';

class MyService {
    constructor(private hcSvc: HealthcheckService) {
        hcSvc.register('Database', async () => {
            // Throw to indicate unhealthy
            await db.rawQuery(sql`SELECT 1`);
        });
    }
}
```

### Database Health Check

When a database class is passed to `createApp()`, a database health check is automatically registered. It verifies the database connection is alive.

## `HealthcheckService`

| Method                                       | Description                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `register(name, fn: () => Promise<void>)`    | Register a named health check function. Throw to indicate failure.                                  |
| `check()`                                    | Run all registered health checks. Throws on first failure.                                          |
| `checkIndividual()`                          | Run all checks and return per-check results: `{ name, status: 'ok' \| 'error', error? }[]`.        |

## Health Module

The `HealthModule` is automatically included by `createApp()`. It provides:

- `HealthcheckService` as a DI provider
- `HealthcheckController` at `/healthz`
- `MetricsController` at `/metrics` (if Prometheus exporter is enabled)
