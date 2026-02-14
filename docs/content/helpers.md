# Helpers

Organized utility functions for common patterns: async context, Redis operations, cryptography, data manipulation, and more.

## Async

### AsyncContext

Request-scoped context using `AsyncLocalStorage`:

```typescript
import { withContext, withContextData, getContextProp, setContextProp, removeContextProp } from '@signal24/dk-server-foundation';

// Run code within a context
await withContext(async () => {
    setContextProp('userId', '123');

    // Available in any nested async call
    const userId = getContextProp<string>('userId');

    removeContextProp('userId');
});

// Run with initial data
await withContextData({ reqId: 'abc', traceId: 'xyz' }, async () => {
    const reqId = getContextProp<string>('reqId');
});
```

### Semaphore

One-time use semaphore for coordinating async operations:

```typescript
import { createSemaphore } from '@signal24/dk-server-foundation';

const { release, promise } = createSemaphore();

// In one place: wait for release
await promise;

// In another place: signal completion
release();
```

### Process Execution

Execute child processes with OpenTelemetry tracing:

```typescript
import { execProcess } from '@signal24/dk-server-foundation';

const result = await execProcess('git', ['status'], {
    cwd: '/path/to/repo',
    errorOnNonZero: true
});

console.log(result.code); // Exit code
console.log(result.stdout.toString()); // stdout
console.log(result.stderr.toString()); // stderr
```

Options:

| Option           | Type             | Default | Description                  |
| ---------------- | ---------------- | ------- | ---------------------------- |
| `cwd`            | `string`         | —       | Working directory            |
| `errorOnNonZero` | `boolean`        | `false` | Throw on non-zero exit code  |
| `stdio`          | —                | —       | Node.js stdio configuration  |
| `onSpawn`        | `(proc) => void` | —       | Callback when process spawns |
| `shell`          | `boolean`        | —       | Run in shell                 |

## Data

### Array Utilities

```typescript
import { toArray, asyncMap } from '@signal24/dk-server-foundation';

toArray('single'); // ['single']
toArray([1, 2, 3]); // [1, 2, 3]

// Sequential async map
const results = await asyncMap(items, async (item, index) => {
    return await processItem(item);
});
```

### Object Utilities

```typescript
import { objectKeys, objectEntries, extractValues, extractUpdates, patchObject, extractKV } from '@signal24/dk-server-foundation';

// Type-safe Object.keys/entries
const keys = objectKeys(myObj); // (keyof typeof myObj)[]
const entries = objectEntries(myObj); // [keyof typeof myObj, ValueType][]

// Extract specific fields
const subset = extractValues(user, ['name', 'email'] as const);
// { name: 'Alice', email: 'a@b.com' }

// Extract only changed fields
const updates = extractUpdates(originalUser, { name: 'Bob', email: 'a@b.com' });
// { name: 'Bob' } (email unchanged)

// Apply partial updates
const updated = patchObject(user, { name: 'Bob' });

// Convert array to key-value map
const map = extractKV(users, 'id', 'name');
// { '1': 'Alice', '2': 'Bob' }
```

### Transformer Pipelines

Chainable data transformation pipelines:

```typescript
import { Transformer } from '@signal24/dk-server-foundation';

const result = await Transformer.create(users)
    .apply(users => users.filter(u => u.active))
    .applyEach(user => ({ ...user, displayName: `${user.first} ${user.last}` }))
    .applyEachAsync(async user => ({
        ...user,
        avatar: await getAvatar(user.id)
    }))
    .narrow('id', 'displayName', 'avatar')
    .get();
```

| Method                             | Description                             |
| ---------------------------------- | --------------------------------------- |
| `apply(fn, shouldApply?)`          | Transform the entire array              |
| `applyEach(fn, shouldApply?)`      | Transform each item synchronously       |
| `applyEachAsync(fn, shouldApply?)` | Transform each item asynchronously      |
| `narrow(...keys)`                  | Select specific fields                  |
| `get()`                            | Execute the pipeline and return results |

### Serialization

```typescript
import { toJson, fromJson } from '@signal24/dk-server-foundation';

const json = toJson({ key: 'value' });
const obj = fromJson<MyType>(json);
```

## Security

### Cryptography

AES-256-GCM encryption and random generation:

```typescript
import { Crypto, randomBytes, randomString, randomBytesSync, randomStringSync } from '@signal24/dk-server-foundation';

// AES-256-GCM encryption (requires CRYPTO_SECRET)
const encrypted = Crypto.encrypt('sensitive data');
const decrypted = Crypto.decrypt(encrypted);

// Also works with Buffers
const encBuf = Crypto.encrypt(Buffer.from('data'));
const decBuf = Crypto.decrypt(encBuf);

// Random bytes
const bytes = await randomBytes(32);
const hex = await randomBytes(32, true); // Returns hex string

// Random strings
const token = await randomString(32); // Alphanumeric
const pin = await randomString(6, NumericCharacters);

// Synchronous variants
const bytesSync = randomBytesSync(32);
const tokenSync = randomStringSync(32);
```

Character sets:

| Constant                          | Characters   |
| --------------------------------- | ------------ |
| `PrintableCharacters`             | ASCII 32-126 |
| `AlphanumericCharacters`          | a-zA-Z0-9    |
| `UpperCaseAlphanumericCharacters` | A-Z0-9       |
| `NumericCharacters`               | 0-9          |

### Validation

```typescript
import { validateOrThrow, assertInput } from '@signal24/dk-server-foundation';

// Validate with Deepkit types (throws ValidationError)
validateOrThrow<MyType>(data);

// Assert non-null/undefined (throws HttpBadRequestError)
assertInput(value);
assertInput(value, 'fieldName'); // Custom field name in error
```

## Framework

### Decorator Utilities

```typescript
import { createSymbolAttachmentClassDecorator, createRegistryClassDecorator, getRegisteredClasses } from '@signal24/dk-server-foundation';

// Registry decorator pattern
const PLUGINS = Symbol('plugins');
const Plugin = createRegistryClassDecorator(PLUGINS);

@Plugin()
class MyPlugin {
    /* ... */
}

const plugins = getRegisteredClasses<typeof MyPlugin>(PLUGINS);
```

### Event Handler Inheritance

Copy Deepkit event listeners from a parent class:

```typescript
import { applyParentEventHandlers } from '@signal24/dk-server-foundation';

class ChildListener extends ParentListener {
    // Inherit parent's @eventDispatcher.listen() handlers
}
applyParentEventHandlers(ChildListener);
```

### DI Introspection

```typescript
import { getProviderTree } from '@signal24/dk-server-foundation';

const tree = getProviderTree(appModule);
// Returns provider tree with names and modules
```

## I/O

### Package Metadata

```typescript
import { getPackageJson, getPackageVersion, getPackageName } from '@signal24/dk-server-foundation';

const pkg = getPackageJson(); // Memoized package.json
const version = getPackageVersion(); // e.g., '1.2.3'
const name = getPackageName(); // e.g., '@signal24/my-app'
```

### Stream Utilities

```typescript
import { safePipe, withResourceCleanup, PipeError } from '@signal24/dk-server-foundation';

// Promise-based pipe with error handling
await safePipe(readableStream, writableStream);

// Automatic cleanup of files and streams
await withResourceCleanup(async tracker => {
    tracker.addFile('/tmp/upload.tmp');
    tracker.addStream(createReadStream('/tmp/upload.tmp'));
    // Files deleted and streams destroyed on exit (even on error)
});
```

## Utils

### Date Utilities

```typescript
import { extractDate, sleepMs, sleepSecs } from '@signal24/dk-server-foundation';

extractDate(new Date()); // '2024-01-15'
await sleepMs(500); // Sleep 500ms
await sleepSecs(2); // Sleep 2 seconds
```

### Error Handling

```typescript
import { isError, getErrorMessage, toError, tryOrError, tryOrErrorSync, reportError, setGlobalErrorReporter } from '@signal24/dk-server-foundation';

isError(value); // Type guard
getErrorMessage(value); // Extract message from any value
toError(value, cause); // Convert to Error with optional cause

// Catch errors as values
const result = await tryOrError(async () => riskyOperation());
if (isError(result)) {
    /* handle */
}

// Report errors to Sentry and Slack
reportError('error', err, { scope: 'payments', data: { orderId: 123 } });

// Override the global error reporter
setGlobalErrorReporter((level, err, context) => {
    // Custom error handling
});
```

### UUID v7

```typescript
import { uuid7, uuid7FromDate } from '@signal24/dk-server-foundation';

const id = uuid7(); // Time-ordered UUID
const id = uuid7FromDate(new Date('2024-01-01')); // UUID from specific date
```

### JSX Rendering

```typescript
import { jsxToHtml } from '@signal24/dk-server-foundation';

const html = await jsxToHtml(<div class="wrapper"><h1>Hello</h1></div>);
// Renders Deepkit JSX templates to HTML strings
```
