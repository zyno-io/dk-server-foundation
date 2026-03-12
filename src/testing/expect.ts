import _ from 'lodash';
import assert from 'node:assert/strict';

const ASYMMETRIC_MATCHER = Symbol.for('asymmetricMatcher');

interface AsymmetricMatcher {
    [ASYMMETRIC_MATCHER]: true;
    check(value: unknown): boolean;
    toString(): string;
}

function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcher {
    return typeof value === 'object' && value !== null && ASYMMETRIC_MATCHER in value;
}

function deepMatch(actual: unknown, expected: unknown): boolean {
    if (isAsymmetricMatcher(expected)) {
        return expected.check(actual);
    }

    if (expected === null || expected === undefined) {
        return actual === expected;
    }

    if (typeof expected !== 'object') {
        return _.isEqual(actual, expected);
    }

    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return false;
        if (actual.length !== expected.length) return false;
        return expected.every((exp, i) => deepMatch(actual[i], exp));
    }

    if (typeof actual !== 'object' || actual === null) return false;

    for (const key of Object.keys(expected as Record<string, unknown>)) {
        if (!deepMatch((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key])) {
            return false;
        }
    }
    return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PRIMITIVE_TYPE_MAP = new Map<any, string>([
    [Number, 'number'],
    [String, 'string'],
    [Boolean, 'boolean'],
    [BigInt, 'bigint'],
    [Symbol, 'symbol']
]);

export function matchesObject(actual: unknown, expected: unknown): void {
    if (!deepMatch(actual, expected)) {
        assert.fail(
            `Expected object to match:\n` + `  Expected: ${JSON.stringify(expected, null, 2)}\n` + `  Actual:   ${JSON.stringify(actual, null, 2)}`
        );
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function anyOf(Type: new (...args: any[]) => any): AsymmetricMatcher {
    const primitiveType = PRIMITIVE_TYPE_MAP.get(Type);
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            if (primitiveType) return typeof value === primitiveType;
            return value instanceof Type;
        },
        toString() {
            return `any(${Type.name})`;
        }
    };
}

export function arrayContaining(expected: unknown[]): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            if (!Array.isArray(value)) return false;
            return expected.every(exp => value.some(v => deepMatch(v, exp)));
        },
        toString() {
            return `arrayContaining(${JSON.stringify(expected)})`;
        }
    };
}

export function stringContaining(expected: string): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            return typeof value === 'string' && value.includes(expected);
        },
        toString() {
            return `stringContaining(${JSON.stringify(expected)})`;
        }
    };
}

export function objectContaining(expected: Record<string, unknown>): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check(value: unknown) {
            if (typeof value !== 'object' || value === null) return false;
            return deepMatch(value, expected);
        },
        toString() {
            return `objectContaining(${JSON.stringify(expected)})`;
        }
    };
}

export function anything(): AsymmetricMatcher {
    return {
        [ASYMMETRIC_MATCHER]: true,
        check() {
            return true;
        },
        toString() {
            return 'anything()';
        }
    };
}

/**
 * Assert that a mock was called with the given arguments at least once.
 * Works with node:test mock.fn() and mock.method() return values.
 */
export function assertCalledWith(mockFn: { mock: { calls: { arguments: unknown[] }[] } }, ...expectedArgs: unknown[]): void {
    const calls = mockFn.mock.calls;
    const match = calls.some(call => {
        if (call.arguments.length !== expectedArgs.length) return false;
        return expectedArgs.every((exp, i) => deepMatch(call.arguments[i], exp));
    });
    if (!match) {
        assert.fail(
            `Expected mock to have been called with:\n` +
                `  Expected: ${JSON.stringify(expectedArgs, null, 2)}\n` +
                `  Actual calls: ${JSON.stringify(
                    calls.map(c => c.arguments),
                    null,
                    2
                )}`
        );
    }
}
