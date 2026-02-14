import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HealthcheckService } from '../../src/health/healthcheck.service';

describe('HealthcheckService', () => {
    describe('checkIndividual', () => {
        it('returns ok for passing checks', async () => {
            const svc = new HealthcheckService();
            svc.register(() => Promise.resolve(), 'db');
            svc.register(() => Promise.resolve(), 'redis');
            const results = await svc.checkIndividual();
            assert.deepStrictEqual(results, [
                { name: 'db', status: 'ok' },
                { name: 'redis', status: 'ok' }
            ]);
        });

        it('returns error status for failing checks', async () => {
            const svc = new HealthcheckService();
            svc.register(() => Promise.resolve(), 'db');
            svc.register(() => {
                throw new Error('connection refused');
            }, 'redis');
            const results = await svc.checkIndividual();
            assert.strictEqual(results[0].status, 'ok');
            assert.strictEqual(results[1].status, 'error');
            assert.strictEqual(results[1].error, 'connection refused');
        });

        it('handles non-Error throws', async () => {
            const svc = new HealthcheckService();
            svc.register(() => {
                throw 'string error';
            }, 'broken');
            const results = await svc.checkIndividual();
            assert.strictEqual(results[0].status, 'error');
            assert.strictEqual(results[0].error, 'string error');
        });

        it('uses default names when not provided', async () => {
            const svc = new HealthcheckService();
            svc.register(() => Promise.resolve());
            svc.register(() => Promise.resolve());
            const results = await svc.checkIndividual();
            assert.strictEqual(results[0].name, 'Check #1');
            assert.strictEqual(results[1].name, 'Check #2');
        });

        it('returns empty array when no checks registered', async () => {
            const svc = new HealthcheckService();
            const results = await svc.checkIndividual();
            assert.deepStrictEqual(results, []);
        });

        it('handles async rejection', async () => {
            const svc = new HealthcheckService();
            svc.register(() => Promise.reject(new Error('timeout')), 'slow-check');
            const results = await svc.checkIndividual();
            assert.strictEqual(results[0].status, 'error');
            assert.strictEqual(results[0].error, 'timeout');
        });
    });
});
