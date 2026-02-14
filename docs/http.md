# HTTP

Custom HTTP layer built on Deepkit's HTTP module with an enhanced kernel, middleware system, error handling, CORS, file uploads, and request-scoped caching.

## Custom HTTP Kernel

`CustomHttpKernel` replaces Deepkit's default kernel with:

- Configurable request logging (mode set via `HTTP_REQUEST_LOGGING_MODE`)
- Request duration tracking
- Active request counting
- AsyncContext integration (request ID, trace ID)
- Abort detection for incomplete requests

### Logging Modes

| Mode     | Description                  |
| -------- | ---------------------------- |
| `e2e`    | Log at request start and end |
| `finish` | Log only at request end      |
| `errors` | Log only errors              |
| `none`   | No request logging           |

Set via `HTTP_REQUEST_LOGGING_MODE` environment variable. Health check logging can be disabled separately with `HEALTHZ_ENABLE_REQUEST_LOGGING=false`.

## Middleware

Extend `HttpMiddleware` for middleware that properly handles HTTP errors and injects CORS headers into error responses:

```typescript
import { HttpMiddleware } from '@signal24/dk-server-foundation';

class RateLimitMiddleware extends HttpMiddleware {
    async handle(request: HttpRequest, response: HttpResponse) {
        const ip = request.getRemoteAddress();
        if (await isRateLimited(ip)) {
            throw new HttpError(429, 'Too many requests');
        }
    }
}
```

Deepkit's default middleware returns 404 on errors -- this base class fixes that behavior.

### Debug Middleware

`HttpLogPayloadMiddleware` logs request method, URL, content-type, and body for debugging.

## CORS

Multi-origin CORS support with regex matching.

### Single Origin

```typescript
const app = createApp({
    cors: config => ({
        hosts: ['https://myapp.com'],
        credentials: true
    })
});
```

### Multiple Origins

```typescript
const app = createApp({
    cors: config => [
        {
            hosts: ['https://app.example.com', /https:\/\/.*\.example\.com/],
            credentials: true
        },
        {
            hosts: ['https://api.partner.com'],
            paths: [/^\/api\/partner/],
            methods: ['GET', 'POST']
        }
    ]
});
```

### `HttpCorsOptions`

| Property        | Type                   | Description                     |
| --------------- | ---------------------- | ------------------------------- |
| `hosts`         | `(string \| RegExp)[]` | Allowed origins                 |
| `paths`         | `(string \| RegExp)[]` | Restrict CORS to specific paths |
| `methods`       | `string[]`             | Allowed HTTP methods            |
| `credentials`   | `boolean`              | Allow credentials               |
| `allowHeaders`  | `string[]`             | Allowed request headers         |
| `exposeHeaders` | `string[]`             | Exposed response headers        |

CORS headers are precomputed early in the request workflow and injected into responses, including error responses from middleware.

## Error Handling

### Built-in HTTP Errors

```typescript
import { HttpUserError, HttpDetailedAccessDeniedError } from '@signal24/dk-server-foundation';

// 422 - User error
throw new HttpUserError('Invalid email format');

// 403 - Access denied with custom message
throw new HttpDetailedAccessDeniedError('Insufficient permissions for this resource');
```

### Error Response Format

All errors are returned as JSON:

```json
{ "error": "Error message here" }
```

The workflow listener standardizes error handling:

- Validation errors in route parameters -> HTTP 400
- JSON parse errors -> HTTP 400
- Validation errors in controllers -> HTTP 500 (internal error)
- Non-HTTP errors are decorated with request body context for debugging (when enabled)

### Request Body Logging

By default, the workflow listener attaches the request body to non-HTTP errors for debugging. This is controlled by `HttpWorkflowListenerOptions`:

```typescript
import { HttpWorkflowListenerOptions } from '@signal24/dk-server-foundation';
```

| Property                | Type      | Default                                      |
| ----------------------- | --------- | -------------------------------------------- |
| `logRequestBodyOnError` | `boolean` | `true` in development, `false` in production |

When `NODE_ENV=production`, request body logging is disabled to avoid leaking sensitive data. Override by providing `HttpWorkflowListenerOptions` as a DI provider:

```typescript
const app = createApp({
    providers: [{ provide: HttpWorkflowListenerOptions, useValue: Object.assign(new HttpWorkflowListenerOptions(), { logRequestBodyOnError: true }) }]
});
```

## Response Type Helpers

The library exports type aliases used as return type annotations on controller methods:

```typescript
import { OkResponse, RedirectResponse, EmptyResponse, AnyResponse } from '@signal24/dk-server-foundation';

class MyController {
    // Return { ok: true }
    @http.POST('/action')
    async doAction(): OkResponse {
        // ... perform action ...
        return OkResponse; // the exported const { ok: true }
    }

    // Redirect (return type annotation)
    @http.GET('/old-path')
    async redirect(): RedirectResponse {
        // Use Deepkit's redirect mechanism
    }

    // Empty response (return type annotation)
    @http.DELETE('/resource/:id')
    async delete(): EmptyResponse {
        // ...
    }

    // Any response (bypasses serialization)
    @http.GET('/raw')
    async raw(): AnyResponse {
        // ...
    }
}
```

`OkResponse` is also exported as a const value `{ ok: true }` for convenience.

## File Uploads

```typescript
import { FileUpload } from '@signal24/dk-server-foundation';

class UploadController {
    @http.POST('/upload')
    async upload(file: FileUpload) {
        console.log(file.path); // Temporary file path
        console.log(file.size); // Size in bytes
        console.log(file.type); // MIME type
        console.log(file.originalName); // Original filename
    }
}
```

Multipart forms use `_payload` as the JSON key for non-file fields.

## Request-Scoped Caching

Cache expensive computations per request to avoid redundant database lookups:

```typescript
import { getOrCacheValue, getCachedValue } from '@signal24/dk-server-foundation';

const USER_KEY = Symbol('user');

// Compute and cache
const user = await getOrCacheValue(request, USER_KEY, async () => {
    return await db.query(User).filter({ id: userId }).findOne();
});

// Retrieve cached value later in the same request
const cachedUser = getCachedValue(request, USER_KEY);
```

### Parameter Resolvers

Create Deepkit route parameter resolvers that cache their results:

```typescript
import { createCachingParameterResolver } from '@signal24/dk-server-foundation';

const CurrentUserResolver = createCachingParameterResolver(USER_KEY, async context => {
    // context is RouteParameterResolverContext (has .request, .type, etc.)
    const jwt = await getJwtFromRequest(context.request);
    return await db.query(User).filter({ id: jwt.subject }).findOne();
});
```

## Real IP Support

When behind a reverse proxy, enable `x-real-ip` header support:

```bash
USE_REAL_IP_HEADER=true
```

This overrides `HttpRequest.getRemoteAddress()` to return the value from the `x-real-ip` header.

## HTTP Context

The HTTP context provides request-scoped data that flows through AsyncContext:

```typescript
import { setHttpContextResolver } from '@signal24/dk-server-foundation';

// Override the default context provider (which generates a reqId)
setHttpContextResolver(request => ({
    reqId: generateRequestId(),
    tenantId: request.headers['x-tenant-id']
}));
```
