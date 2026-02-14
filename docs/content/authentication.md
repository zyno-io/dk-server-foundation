# Authentication

JWT (HS256/EdDSA) and HTTP Basic Auth with request-scoped caching and entity resolution.

## JWT

### Configuration

Configure via environment variables (see [Configuration](./configuration.md)):

- `AUTH_JWT_SECRET` -- Plain string HMAC key (HS256)
- `AUTH_JWT_SECRET_B64` -- Base64-encoded HMAC key (HS256)
- `AUTH_JWT_ED_SECRET` -- EdDSA private key (PEM format, base64-encoded)
- `AUTH_JWT_ISSUER` -- Issuer claim
- `AUTH_JWT_EXPIRATION_MINS` -- Token expiration in minutes
- `AUTH_JWT_COOKIE_NAME` -- Cookie name for JWT storage
- `AUTH_JWT_ENABLE_VERIFY` -- Enable signature verification (default: `true`)

### Generating Tokens

```typescript
import { JWT } from '@signal24/dk-server-foundation';

// Generate a JWT
const token = await JWT.generate({
    subject: user.id.toString(),
    payload: { role: user.role }
});

// Generate and set as HttpOnly cookie
await JWT.generateCookie({ subject: user.id.toString(), payload: { role: user.role } }, response);

// Clear the JWT cookie
JWT.clearCookie(response);
```

### Verifying Tokens

```typescript
import { JWT } from '@signal24/dk-server-foundation';

// Verify signature and claims
const result = await JWT.verify<{ role: string }>(token);
if (result.isValid) {
    console.log(result.subject); // User ID
    console.log(result.payload.role); // Typed payload
} else {
    // Granular failure inspection
    console.log(result.isDecodable); // Could the token be decoded?
    console.log(result.isSignatureValid); // Was the signature valid?
    console.log(result.isPayloadValid); // Were the claims valid?
    console.log(result.isNotExpired); // Is the token not expired?
}

// Decode without verification
const decoded = await JWT.decode<{ role: string }>(token);

// Process (verify or decode based on AUTH_JWT_ENABLE_VERIFY)
const processed = await JWT.process(token);

// Extract from request (Bearer token or cookie)
const fromReq = await JWT.processWithRequest(request);
```

### Custom Verifiers

Create verifiers with different keys or options:

```typescript
const verifier = JWT.createVerifier({
    key: 'custom-secret',
    algorithm: 'HS256'
});

// verifier is an async function: (token) => Promise<JwtValidationResult>
const result = await verifier(token);
```

### JWT Result Types

```typescript
// Valid JWT (class with isValid = true)
class ParsedJwt<T> {
    readonly isValid = true;
    id?: string;
    issuer!: string;
    audience?: string;
    subject!: string;
    issuedAtMs!: number;
    get issuedAt(): Date; // Derived from issuedAtMs
    expiresAtMs!: number;
    get expiresAt(): Date; // Derived from expiresAtMs
    payload!: T;
    rawPayload!: Record<string, any>;
}

// Invalid JWT
interface InvalidJwtValidationResult {
    isValid: false;
    isDecodable: boolean;
    isSignatureValid?: boolean;
    isPayloadValid?: boolean;
    isNotExpired?: boolean;
}

type JwtValidationResult<T> = ParsedJwt<T> | InvalidJwtValidationResult;
```

## Entity Authentication Middleware

`createAuthMiddleware()` returns a middleware class that validates the JWT and caches the entity ID. Extend it to add entity validation:

```typescript
import { createAuthMiddleware, getEntityFromRequestJwt } from '@signal24/dk-server-foundation';

// Basic auth middleware - validates JWT has a subject
const AuthMiddleware = createAuthMiddleware(User);

// With custom entity validation (extend the returned class)
class StrictAuthMiddleware extends createAuthMiddleware(User) {
    async validateEntity(request: HttpRequest, entity: User) {
        if (entity.isSuspended) {
            throw new HttpAccessDeniedError();
        }
    }
}

// Use in controllers
@http.controller('/api')
class UserController {
    @(http.GET('/me').use(AuthMiddleware))
    async getMe(request: HttpRequest) {
        const user = await getEntityFromRequestJwt(request, User);
        return user;
    }
}
```

### How It Works

1. JWT extracted from `Authorization: Bearer <token>` header or cookie
2. JWT verified (or decoded if `AUTH_JWT_ENABLE_VERIFY=false`)
3. Entity ID extracted from JWT subject and cached per-request
4. If the subclass defines `validateEntity()`, the entity is loaded and validated
5. Entity ID and entity are cached per-request (subsequent accesses don't hit the database)

### Lower-Level Functions

```typescript
import { getJwtFromRequest, getEntityFromRequestJwt, getEntityIdFromRequestJwt } from '@signal24/dk-server-foundation';

// Get parsed JWT from request (cached)
const jwt = await getJwtFromRequest(request);

// Get entity from JWT subject
const user = await getEntityFromRequestJwt(request, User);

// Get just the entity ID from JWT subject
const userId = await getEntityIdFromRequestJwt(request);
```

## HTTP Basic Auth

Create middleware for HTTP Basic Authentication using the `AUTH_BASIC_SECRET` config value:

```typescript
import { createBasicAuthMiddleware } from '@signal24/dk-server-foundation';

// Any username, password must match AUTH_BASIC_SECRET
const basicAuth = createBasicAuthMiddleware();

// Specific username required
const basicAuth = createBasicAuthMiddleware('admin');

@http.GET('/admin/stats').use(basicAuth)
async getStats() {
    return { users: 100 };
}
```

## Password Hashing

```typescript
import { Auth } from '@signal24/dk-server-foundation';

// Hash a password (bcrypt, default 10 rounds)
const hash = await Auth.hashPassword('my-password');
const hash = await Auth.hashPassword('my-password', 12); // custom rounds

// Verify a password
const isValid = await Auth.verifyHash('my-password', hash);
```

## Reset Tokens

Generate secure tokens for password resets, email verification, etc.:

```typescript
import { Auth } from '@signal24/dk-server-foundation';

// Generate a reset token with embedded data
const { token, verifier, generatedAt } = await Auth.generateResetToken({
    userId: 123,
    email: 'user@example.com'
});
// token: base64-encoded string containing timestamp + verifier + data

// Decode the token
const decoded = await Auth.decodeResetToken<{ userId: number; email: string }>(token);
console.log(decoded.data.userId); // 123
console.log(decoded.generatedAt); // Date
console.log(decoded.verifier); // Buffer (16 bytes)
```

The token embeds a 4-byte timestamp, 16-byte random verifier, and JSON-serialized data, all base64-encoded. The `verifier` field is a base64-encoded string (not a Buffer), and `generationTime` is a Unix timestamp in milliseconds.
