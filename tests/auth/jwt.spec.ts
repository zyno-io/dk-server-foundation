import { generateKeyPairSync, randomBytes } from 'crypto';
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import { BaseAppConfig } from '../../src/app/config';
import { resetSrcModuleCache } from '../shared/helpers';

function getJWT(config: Partial<BaseAppConfig>) {
    resetSrcModuleCache();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolver = require('../../src/app/resolver');
    resolver.getAppConfig = () => {
        const appConfig = new BaseAppConfig();
        Object.assign(appConfig, config);
        return appConfig;
    };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JWT } = require('../../src/auth/jwt');
    return JWT;
}

afterEach(() => {
    resetSrcModuleCache();
});

describe('JWT', () => {
    it('generates and validates with HS256', async () => {
        const key = randomBytes(32).toString('base64');
        const JWT = getJWT({ AUTH_JWT_ISSUER: 'testiss', AUTH_JWT_SECRET: key });

        const subject = new Date().toISOString();
        const token = await JWT.generate({ subject });
        const result = await JWT.verify(token);

        assert.strictEqual(result.isValid, true);
        assert(result.isValid);

        assert.strictEqual(result.subject, subject);

        const result2 = await JWT.verify(token + 'a');
        assert.strictEqual(result2.isValid, false);
    });

    it('generates and validates with EdDSA', async () => {
        const { privateKey } = generateKeyPairSync('ed25519');
        const privateKeyPEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }))
            .replace('-----BEGIN PRIVATE KEY-----\n', '')
            .replace('\n-----END PRIVATE KEY-----', '')
            .trim();

        const JWT = getJWT({ AUTH_JWT_ISSUER: 'testiss', AUTH_JWT_ED_SECRET: privateKeyPEM });

        const subject = new Date().toISOString();
        const token = await JWT.generate({ subject, expiresAt: new Date('2199-12-31') });
        const result = await JWT.verify(token);

        assert.strictEqual(result.isValid, true);
        assert(result.isValid);

        assert.strictEqual(result.subject, subject);

        const result2 = await JWT.verify(token + 'a');
        assert.strictEqual(result2.isValid, false);
    });

    it('validates a separate payload with a different EdDSA key', async () => {
        const key = randomBytes(32).toString('base64');
        const JWT = getJWT({ AUTH_JWT_ISSUER: 'testiss', AUTH_JWT_SECRET: key });

        const altKey = 'MCowBQYDK2VwAyEAITr14T5sFiLdEIXgHLJAp22rSKpVdZQjbr4mskSr8lU=';
        const altPayload =
            'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0ZXN0aXNzIiwic3ViIjoiMjAyMy0xMi0yOVQwOToyNzoyMy45NjVaIiwiZXhwIjo3MjU4MDMyMDAwLCJpYXQiOjE3MDM4NDIwNDN9.gkX7D4bWmh6qTpVfkGThKu12sXkOvws7DcoF09AWfCpyhspMmzo6Crso4Roe-i-wVXOQY9ZeHIZIeSnpES5rBQ';

        const altVerifier = JWT.createVerifier({
            key: altKey,
            algorithm: 'EdDSA'
        });

        const result = await altVerifier(altPayload);
        assert.strictEqual(result.isValid, true);
        assert(result.isValid);

        assert.strictEqual(result.subject, '2023-12-29T09:27:23.965Z');

        const result2 = await JWT.verify(altPayload + 'a');
        assert.strictEqual(result2.isValid, false);
    });
});
