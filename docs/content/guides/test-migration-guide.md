# Migrating from Jest to node:test (dk-server-foundation)

This guide documents how to migrate a project that uses `@signal24/dk-server-foundation` from Jest to Node.js's built-in `node:test` runner. It is written as a reference for Claude and other AI assistants performing this migration.

## Why node:test?

Since projects already build to CJS via `tsc` (which runs the Deepkit type compiler), testing against the built output eliminates test-time compilation entirely — Deepkit reflection is already compiled in.

Benefits:

- Tests run against the same compiled output as production
- Faster test startup (no transform pipeline)
- Zero-config Deepkit reflection (already compiled by `tsc`)

## Step-by-step migration

### 1. Create `tsconfig.test.json`

Extend the base `tsconfig.json` to also compile test files:

```json
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "declaration": false,
        "declarationMap": false
    },
    "include": ["src/**/*", "tests/**/*", "types.d.ts"]
}
```

This compiles `tests/` into `dist/tests/` alongside `dist/src/`. Relative imports like `../../src/foo` naturally resolve to `dist/src/foo` in the output.

### 2. Create `globalSetup.ts`

Create `tests/shared/globalSetup.ts` with `setup` and `teardown` exports:

```typescript
import { TestingHelpers } from '@signal24/dk-server-foundation';

export async function setup() {
    TestingHelpers.setDefaultDatabaseConfig({
        MYSQL_HOST: 'localhost',
        MYSQL_PORT: 3306,
        MYSQL_USER: 'root',
        MYSQL_PASSWORD_SECRET: 'secret'
    });

    await TestingHelpers.cleanupTestDatabases('myapp_test');
}

export async function teardown() {
    await TestingHelpers.cleanupTestDatabases('myapp_test');
}
```

The `dksf-test` runner will automatically load `dist/tests/shared/globalSetup.js` if it exists, calling `setup()` before tests and `teardown()` after.

### 3. Update `package.json` scripts

```json
{
    "scripts": {
        "test": "tsc -p tsconfig.test.json && dksf-test",
        "test:debug": "tsc -p tsconfig.test.json && node --inspect=9201 node_modules/.bin/dksf-test"
    }
}
```

`dksf-test` sets `APP_ENV=test` and `TZ=UTC` automatically, finds all `*.spec.js` files in `dist/tests/`, and runs them with `node --test`. You can pass specific files and node flags:

```bash
# Run a single test file (source path is mapped to dist automatically)
yarn test tests/my-feature.spec.ts

# Pass node flags
yarn test --test-name-pattern="my test"
```

Remove Jest dependencies and configuration files.

### 4. Migrate test imports

Add explicit imports at the top of each test file:

```typescript
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
```

Rename any `beforeAll`/`afterAll` calls to `before`/`after`.

### 5. Migrate assertions

#### Simple replacements

| Jest                                        | node:test                                         |
| ------------------------------------------- | ------------------------------------------------- |
| `expect(x).toBe(y)`                         | `assert.strictEqual(x, y)`                        |
| `expect(x).toEqual(y)`                      | `assert.deepStrictEqual(x, y)`                    |
| `expect(x).toBeDefined()`                   | `assert.notStrictEqual(x, undefined)`             |
| `expect(x).toBeUndefined()`                 | `assert.strictEqual(x, undefined)`                |
| `expect(x).toBeNull()`                      | `assert.strictEqual(x, null)`                     |
| `expect(x).toBeTruthy()`                    | `assert.ok(x)`                                    |
| `expect(x).toBeFalsy()`                     | `assert.ok(!x)`                                   |
| `expect(x).toBeInstanceOf(Y)`               | `assert.ok(x instanceof Y)`                       |
| `expect(x).toHaveLength(n)`                 | `assert.strictEqual(x.length, n)`                 |
| `expect(x).toContain(y)`                    | `assert.ok(x.includes(y))`                        |
| `expect(x).toMatch(/re/)`                   | `assert.match(x, /re/)`                           |
| `expect(x).toBeGreaterThan(n)`              | `assert.ok(x > n)`                                |
| `expect(x).toBeGreaterThanOrEqual(n)`       | `assert.ok(x >= n)`                               |
| `expect(x).toBeLessThan(n)`                 | `assert.ok(x < n)`                                |
| `expect(x).toHaveProperty(k)`               | `assert.ok(k in x)`                               |
| `expect(x).not.toBe(y)`                     | `assert.notStrictEqual(x, y)`                     |
| `expect(x).not.toEqual(y)`                  | `assert.notDeepStrictEqual(x, y)`                 |
| `expect(() => fn()).toThrow(msg)`           | `assert.throws(() => fn(), { message: msg })`     |
| `expect(() => fn()).toThrow(ErrClass)`      | `assert.throws(() => fn(), ErrClass)`             |
| `expect(() => fn()).toThrow(/re/)`          | `assert.throws(() => fn(), /re/)`                 |
| `expect(() => fn()).not.toThrow()`          | `assert.doesNotThrow(() => fn())`                 |
| `expect(promise).rejects.toThrow(msg)`      | `await assert.rejects(promise, { message: msg })` |
| `expect(promise).rejects.toThrow(/re/)`     | `await assert.rejects(promise, /re/)`             |
| `expect(promise).rejects.toThrow(ErrClass)` | `await assert.rejects(promise, ErrClass)`         |

#### `toMatchObject` — use `matchesObject` from dk-server-foundation

```typescript
import { matchesObject } from '@signal24/dk-server-foundation/testing/expect';

// Before
expect(result).toMatchObject({ name: 'Fred', age: 30 });

// After
matchesObject(result, { name: 'Fred', age: 30 });
```

#### Asymmetric matchers — use helpers from dk-server-foundation

```typescript
import { matchesObject, anyOf, stringContaining, arrayContaining, anything, objectContaining } from '@signal24/dk-server-foundation/testing/expect';

// Before
expect(result).toMatchObject({ id: expect.any(Number), name: expect.stringContaining('Fred') });

// After
matchesObject(result, { id: anyOf(Number), name: stringContaining('Fred') });
```

Available matchers:
| Jest | dk-server-foundation |
|---|---|
| `expect.any(Type)` | `anyOf(Type)` |
| `expect.anything()` | `anything()` |
| `expect.stringContaining(s)` | `stringContaining(s)` |
| `expect.arrayContaining(arr)` | `arrayContaining(arr)` |
| `expect.objectContaining(obj)` | `objectContaining(obj)` |

#### Mock assertions — use `assertCalledWith`

```typescript
import { assertCalledWith, anyOf } from '@signal24/dk-server-foundation/testing/expect';

// Before
expect(mockFn).toHaveBeenCalledWith('arg1', expect.any(Number));

// After
assertCalledWith(mockFn, 'arg1', anyOf(Number));
```

Other mock assertion conversions:

| Jest                                  | node:test                                    |
| ------------------------------------- | -------------------------------------------- |
| `expect(fn).toHaveBeenCalledTimes(n)` | `assert.strictEqual(fn.mock.callCount(), n)` |
| `expect(fn).toHaveBeenCalled()`       | `assert.ok(fn.mock.callCount() > 0)`         |
| `expect(fn).not.toHaveBeenCalled()`   | `assert.strictEqual(fn.mock.callCount(), 0)` |
| `fn.mock.calls[0][1]`                 | `fn.mock.calls[0].arguments[1]`              |
| `fn.mockClear()`                      | `fn.mock.resetCalls()`                       |

### 6. Migrate mock APIs

| Jest                                           | node:test                                 |
| ---------------------------------------------- | ----------------------------------------- |
| `jest.fn()`                                    | `mock.fn()`                               |
| `jest.fn(() => value)`                         | `mock.fn(() => value)`                    |
| `jest.spyOn(obj, method)`                      | `mock.method(obj, method)`                |
| `jest.spyOn(obj, method).mockReturnValue(x)`   | `mock.method(obj, method, () => x)`       |
| `jest.spyOn(obj, method).mockResolvedValue(x)` | `mock.method(obj, method, async () => x)` |
| `jest.clearAllMocks()`                         | Per-mock `fn.mock.resetCalls()`           |
| `jest.restoreAllMocks()`                       | `mock.restoreAll()`                       |
| `jest.useFakeTimers()`                         | `mock.timers.enable()`                    |
| `jest.advanceTimersByTime(n)`                  | `mock.timers.tick(n)`                     |
| `jest.useRealTimers()`                         | `mock.timers.reset()`                     |
| `jest.setTimeout(n)`                           | `--test-timeout=N` flag in test runner    |

#### `mockReturnValue` / `mockImplementation` on existing mocks

node:test does not have `mockReturnValue()` or `mockImplementation()` on mock instances. Instead, pass the implementation when creating the mock:

```typescript
// Jest
const fn = jest.fn();
fn.mockReturnValue(42);
fn.mockImplementation(x => x * 2);

// node:test
const fn = mock.fn(() => 42);
// To change implementation later, create a new mock or use a wrapper:
let impl = (x: number) => x * 2;
const fn = mock.fn((x: number) => impl(x));
impl = (x: number) => x * 3; // change behavior
```

#### `mockReturnValueOnce` — no direct equivalent

Use a counter or array of return values:

```typescript
// Jest
fn.mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValue(0);

// node:test
const returns = [1, 2];
const fn = mock.fn(() => returns.shift() ?? 0);
```

### 7. Migrate module mocking

Since tests run against CJS output, use `require.cache` manipulation with `TestingHelpers.resetSrcModuleCache()`:

```typescript
// Before (Jest)
jest.doMock('../../src/app/resolver', () => ({
    getAppConfig: () => mockConfig
}));
const { MyModule } = await import('../../src/my-module');

// After (node:test with CJS)
import { TestingHelpers } from '@signal24/dk-server-foundation';

TestingHelpers.resetSrcModuleCache();
const resolver = require('../../src/app/resolver');
resolver.getAppConfig = () => mockConfig;
const { MyModule } = require('../../src/my-module');
```

This works because CJS `import { x } from 'y'` compiles to `const y_1 = require('y')`, preserving a reference to the module exports object. Patching `resolver.getAppConfig` is visible to all subsequently-required modules.

### 8. Migrate `it.skip`, `it.only`, `it.each`

**`it.skip` / `describe.skip`** — same syntax, works identically:

```typescript
it.skip('not yet implemented', () => { ... });
describe.skip('disabled suite', () => { ... });
```

**`it.only` / `describe.only`** — same syntax, but only affects the current file. To filter tests across files, use `--test-name-pattern`:

```bash
node --test --test-name-pattern="my test name" dist/tests/**/*.spec.js
```

**`it.each` / `describe.each`** — no built-in equivalent. Use a loop:

```typescript
// Jest
it.each([
    [1, 2, 3],
    [4, 5, 9]
])('adds %i + %i = %i', (a, b, expected) => {
    expect(a + b).toBe(expected);
});

// node:test
for (const [a, b, expected] of [
    [1, 2, 3],
    [4, 5, 9]
]) {
    it(`adds ${a} + ${b} = ${expected}`, () => {
        assert.strictEqual(a + b, expected);
    });
}
```

### 9. Migrate test timeouts

| Jest                     | node:test                             |
| ------------------------ | ------------------------------------- |
| `it('name', fn, 30_000)` | `it('name', { timeout: 30_000 }, fn)` |
| `beforeAll(fn, 10_000)`  | `before(fn, { timeout: 10_000 })`     |

### 10. Environment detection

The `isTest` constant in dk-server-foundation checks `process.env.APP_ENV === 'test'`. The config loader auto-detects `node --test` and sets `APP_ENV=test` if it wasn't already set, so test-time behaviors (e.g., skipping worker job queueing) work automatically.

### 11. Clean up Redis connections

If your tests use Redis-backed features (mutex, cache, leader election, mesh), call `disconnectAllRedis()` in your top-level `after()` hook to properly close memoized connections. Without this, `node:test` child processes will hang waiting for the event loop to drain.

```typescript
import { after } from 'node:test';
import { disconnectAllRedis } from '@signal24/dk-server-foundation';

after(async () => {
    await tf.stop();
    await disconnectAllRedis();
});
```

### 12. Remove old config files

Delete these files if they exist:

- `jest.config.js` / `jest.config.ts`

## Troubleshooting

### `APP_ENV must be specified in the environment`

Set `APP_ENV=test` in your test runner script (see step 2). The config loader auto-detects `node --test`, but if you use a custom runner that spawns node separately, set the env var explicitly.

### Tests hang or time out

`node:test` runs test files sequentially by default. If your `before`/`after` hooks don't complete (e.g., database connection not closing), the entire suite will hang. Ensure all connections are properly closed in `after()` hooks. See step 10 for Redis cleanup.

### `beforeAll` / `afterAll` is not defined

Replace with `before`/`after` from `node:test`:

```typescript
import { before, after } from 'node:test';
```

### Source maps not working

Ensure `--enable-source-maps` is passed to `node` in your test runner. The `tsconfig.json` must have `"sourceMap": true`.

### Mock function call structure differences

In `node:test`, mock call arguments are accessed via `.arguments` property, not as a flat array:

```typescript
// Jest
fn.mock.calls[0][1]; // second argument of first call

// node:test
fn.mock.calls[0].arguments[1]; // second argument of first call
```
