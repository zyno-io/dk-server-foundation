import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDate, sleepMs, sleepSecs } from '../../src/helpers/utils/date';

describe('Date helpers', () => {
    describe('extractDate', () => {
        it('formats date as yyyy-MM-dd', () => {
            const date = new Date('2024-03-15T10:30:45.123Z');
            assert.strictEqual(extractDate(date), '2024-03-15');
        });

        it('handles first day of year', () => {
            const date = new Date('2024-01-01T00:00:00.000Z');
            assert.strictEqual(extractDate(date), '2024-01-01');
        });

        it('handles last day of year', () => {
            const date = new Date('2024-12-31T23:59:59.999Z');
            assert.strictEqual(extractDate(date), '2024-12-31');
        });

        it('handles leap year date', () => {
            const date = new Date('2024-02-29T12:00:00.000Z');
            assert.strictEqual(extractDate(date), '2024-02-29');
        });

        it('pads single digit months and days', () => {
            const date = new Date('2024-05-07T12:00:00.000Z');
            assert.strictEqual(extractDate(date), '2024-05-07');
        });
    });

    describe('sleepMs', () => {
        it('resolves after specified milliseconds', async () => {
            const start = Date.now();
            await sleepMs(50);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 45);
            assert.ok(elapsed < 100);
        });

        it('resolves immediately for zero milliseconds', async () => {
            const start = Date.now();
            await sleepMs(0);
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 10);
        });

        it('returns a promise', () => {
            const result = sleepMs(10);
            assert.ok(result instanceof Promise);
        });

        it('can be awaited multiple times sequentially', async () => {
            const start = Date.now();
            await sleepMs(25);
            await sleepMs(25);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 45);
            assert.ok(elapsed < 100);
        });
    });

    describe('sleepSecs', () => {
        it('resolves after specified seconds', async () => {
            const start = Date.now();
            await sleepSecs(0.05); // 50ms
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 45);
            assert.ok(elapsed < 100);
        });

        it('converts seconds to milliseconds correctly', async () => {
            const start = Date.now();
            await sleepSecs(0.1); // 100ms
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 95);
            assert.ok(elapsed < 150);
        });

        it('resolves immediately for zero seconds', async () => {
            const start = Date.now();
            await sleepSecs(0);
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 10);
        });

        it('returns a promise', () => {
            const result = sleepSecs(0.01);
            assert.ok(result instanceof Promise);
        });
    });
});
