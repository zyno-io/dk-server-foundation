import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { maskSecrets, collectProperties } from '../../src/devconsole/devconsole.ws';

describe('maskSecrets', () => {
    it('masks keys containing SECRET', () => {
        const result = maskSecrets({ DATABASE_SECRET: 'hunter2' });
        assert.strictEqual(result.DATABASE_SECRET, '****');
    });

    it('masks keys containing PASSWORD', () => {
        const result = maskSecrets({ dbPassword: 'hunter2' });
        assert.strictEqual(result.dbPassword, '****');
    });

    it('masks keys containing DSN', () => {
        const result = maskSecrets({ SENTRY_DSN: 'https://abc@sentry.io/123' });
        assert.strictEqual(result.SENTRY_DSN, '****');
    });

    it('masks keys containing TOKEN', () => {
        const result = maskSecrets({ API_TOKEN: 'tok_123' });
        assert.strictEqual(result.API_TOKEN, '****');
    });

    it('masks keys containing KEY', () => {
        const result = maskSecrets({ ENCRYPTION_KEY: 'abc123' });
        assert.strictEqual(result.ENCRYPTION_KEY, '****');
    });

    it('is case-insensitive for key matching', () => {
        const result = maskSecrets({ my_secret: 'val', My_Password: 'val' });
        assert.strictEqual(result.my_secret, '****');
        assert.strictEqual(result.My_Password, '****');
    });

    it('does not mask non-sensitive keys', () => {
        const result = maskSecrets({ APP_ENV: 'production', PORT: 3000, DEBUG: true });
        assert.deepStrictEqual(result, { APP_ENV: 'production', PORT: 3000, DEBUG: true });
    });

    it('does not mask falsy values even if key matches', () => {
        const result = maskSecrets({ API_SECRET: '', ANOTHER_SECRET: 0 as any, NULL_TOKEN: null as any });
        assert.strictEqual(result.API_SECRET, '');
        assert.strictEqual(result.ANOTHER_SECRET, 0);
        assert.strictEqual(result.NULL_TOKEN, null);
    });

    it('preserves all original keys', () => {
        const input = { APP_ENV: 'dev', DB_PASSWORD: 'secret', PORT: 8080 };
        const result = maskSecrets(input);
        assert.deepStrictEqual(Object.keys(result).sort(), ['APP_ENV', 'DB_PASSWORD', 'PORT']);
    });

    it('does not modify the original object', () => {
        const input = { DB_PASSWORD: 'secret' };
        maskSecrets(input);
        assert.strictEqual(input.DB_PASSWORD, 'secret');
    });

    it('returns empty object for empty input', () => {
        assert.deepStrictEqual(maskSecrets({}), {});
    });
});

describe('collectProperties', () => {
    it('collects own properties matching prefix', () => {
        const obj = { getName: () => {}, getAge: () => {}, setName: () => {} };
        const result = collectProperties(obj, 'get');
        assert.deepStrictEqual(result, [
            { label: 'getAge', kind: 'method' },
            { label: 'getName', kind: 'method' }
        ]);
    });

    it('identifies methods, properties, and accessors', () => {
        const obj = Object.create(null);
        Object.defineProperty(obj, 'myMethod', { value: () => {}, enumerable: true });
        Object.defineProperty(obj, 'myProp', { value: 42, enumerable: true });
        Object.defineProperty(obj, 'myAccessor', { get: () => 1, enumerable: true });
        const result = collectProperties(obj, 'my');
        const byLabel = Object.fromEntries(result.map(r => [r.label, r.kind]));
        assert.strictEqual(byLabel.myMethod, 'method');
        assert.strictEqual(byLabel.myProp, 'property');
        assert.strictEqual(byLabel.myAccessor, 'accessor');
    });

    it('traverses prototype chain', () => {
        class Base {
            baseMethod() {}
        }
        class Child extends Base {
            childMethod() {}
        }
        const obj = new Child();
        const result = collectProperties(obj, '');
        const labels = result.map(r => r.label);
        assert.ok(labels.includes('baseMethod'));
        assert.ok(labels.includes('childMethod'));
    });

    it('skips __dunder properties', () => {
        const obj = { __proto__value: 1, __internal: 2, normal: 3 };
        const result = collectProperties(obj, '');
        const labels = result.map(r => r.label);
        assert.ok(!labels.includes('__proto__value'));
        assert.ok(!labels.includes('__internal'));
        assert.ok(labels.includes('normal'));
    });

    it('deduplicates across prototype chain', () => {
        class Base {
            toString() {
                return 'base';
            }
        }
        class Child extends Base {
            toString() {
                return 'child';
            }
        }
        const obj = new Child();
        const result = collectProperties(obj, 'toString');
        assert.strictEqual(result.length, 1);
    });

    it('returns empty array for null/undefined', () => {
        assert.deepStrictEqual(collectProperties(null, ''), []);
        assert.deepStrictEqual(collectProperties(undefined, ''), []);
    });

    it('results are sorted alphabetically', () => {
        const obj = { zebra: 1, apple: 2, mango: 3 };
        const result = collectProperties(obj, '');
        const labels = result.map(r => r.label);
        assert.deepStrictEqual(labels, [...labels].sort());
    });

    it('stops at Object.prototype', () => {
        const obj = { myProp: 1 };
        const result = collectProperties(obj, '');
        const labels = result.map(r => r.label);
        // Should not include Object.prototype methods like hasOwnProperty
        assert.ok(!labels.includes('hasOwnProperty'));
        assert.ok(!labels.includes('toString'));
    });
});
