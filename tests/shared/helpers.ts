import assert from 'node:assert/strict';

/**
 * Asserts that `actual` contains all properties from `expected` (deep partial match).
 * Equivalent to jest's `expect(actual).toMatchObject(expected)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertMatchObject(actual: any, expected: any, path = ''): void {
    if (typeof expected !== 'object' || expected === null) {
        if (path) {
            assert.strictEqual(actual, expected, `at ${path}`);
        } else {
            assert.strictEqual(actual, expected);
        }
        return;
    }

    if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), `Expected array${path ? ` at ${path}` : ''}`);
        assert.ok(actual.length >= expected.length, `Array too short${path ? ` at ${path}` : ''}: got ${actual.length}, need >= ${expected.length}`);
        for (let i = 0; i < expected.length; i++) {
            assertMatchObject(actual[i], expected[i], `${path}[${i}]`);
        }
        return;
    }

    assert.ok(typeof actual === 'object' && actual !== null, `Expected object${path ? ` at ${path}` : ''}`);
    for (const [key, value] of Object.entries(expected)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assertMatchObject((actual as any)[key], value, path ? `${path}.${key}` : key);
    }
}

/**
 * Clears specific modules from the require cache so they can be re-evaluated.
 * Used for tests that need module-level mocking via require.cache manipulation.
 */
export function resetSrcModuleCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/dist/') || key.includes('/src/')) {
            delete require.cache[key];
        }
    }
}
