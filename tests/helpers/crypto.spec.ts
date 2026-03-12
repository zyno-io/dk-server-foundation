import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
    AlphanumericCharacters,
    Crypto,
    NumericCharacters,
    PrintableCharacters,
    randomBytes,
    randomBytesSync,
    randomString,
    randomStringSync,
    UpperCaseAlphanumericCharacters
} from '../../src/helpers/security/crypto';
import { resetSrcModuleCache } from '../shared/helpers';

describe('Crypto helpers', () => {
    describe('randomBytes', () => {
        it('generates buffer of specified length', async () => {
            const bytes = await randomBytes(16);
            assert.strictEqual(Buffer.isBuffer(bytes), true);
            assert.strictEqual(bytes.length, 16);
        });

        it('generates hex string when requested', async () => {
            const hex = await randomBytes(16, true);
            assert.strictEqual(typeof hex, 'string');
            assert.strictEqual(hex.length, 32); // 16 bytes = 32 hex chars
            assert.strictEqual(/^[0-9a-f]+$/.test(hex), true);
        });

        it('generates different values each time', async () => {
            const bytes1 = await randomBytes(16);
            const bytes2 = await randomBytes(16);
            assert.strictEqual(bytes1.equals(bytes2), false);
        });

        it('handles zero length', async () => {
            const bytes = await randomBytes(0);
            assert.strictEqual(bytes.length, 0);
        });

        it('handles large lengths', async () => {
            const bytes = await randomBytes(1024);
            assert.strictEqual(bytes.length, 1024);
        });
    });

    describe('randomBytesSync', () => {
        it('generates buffer of specified length synchronously', () => {
            const bytes = randomBytesSync(16);
            assert.strictEqual(Buffer.isBuffer(bytes), true);
            assert.strictEqual(bytes.length, 16);
        });

        it('generates hex string when requested', () => {
            const hex = randomBytesSync(16, true);
            assert.strictEqual(typeof hex, 'string');
            assert.strictEqual(hex.length, 32);
            assert.strictEqual(/^[0-9a-f]+$/.test(hex), true);
        });

        it('generates different values each time', () => {
            const bytes1 = randomBytesSync(16);
            const bytes2 = randomBytesSync(16);
            assert.strictEqual(bytes1.equals(bytes2), false);
        });
    });

    describe('randomString', () => {
        it('generates string of specified length', async () => {
            const str = await randomString(20);
            assert.strictEqual(typeof str, 'string');
            assert.strictEqual(str.length, 20);
        });

        it('uses printable characters by default', async () => {
            const str = await randomString(100);
            for (const char of str) {
                assert.strictEqual(PrintableCharacters.includes(char), true);
            }
        });

        it('generates alphanumeric string when specified', async () => {
            const str = await randomString(50, AlphanumericCharacters);
            assert.strictEqual(/^[a-zA-Z0-9]+$/.test(str), true);
        });

        it('generates uppercase alphanumeric string', async () => {
            const str = await randomString(50, UpperCaseAlphanumericCharacters);
            assert.strictEqual(/^[A-Z0-9]+$/.test(str), true);
        });

        it('generates numeric string', async () => {
            const str = await randomString(50, NumericCharacters);
            assert.strictEqual(/^[0-9]+$/.test(str), true);
        });

        it('generates different values each time', async () => {
            const str1 = await randomString(20);
            const str2 = await randomString(20);
            assert.notStrictEqual(str1, str2);
        });

        it('handles empty length', async () => {
            const str = await randomString(0);
            assert.strictEqual(str, '');
        });

        it('works with custom character set', async () => {
            const customChars = 'ABC';
            const str = await randomString(30, customChars);
            for (const char of str) {
                assert.ok(customChars.includes(char));
            }
        });
    });

    describe('randomStringSync', () => {
        it('generates string of specified length synchronously', () => {
            const str = randomStringSync(20);
            assert.strictEqual(typeof str, 'string');
            assert.strictEqual(str.length, 20);
        });

        it('generates alphanumeric string when specified', () => {
            const str = randomStringSync(50, AlphanumericCharacters);
            assert.strictEqual(/^[a-zA-Z0-9]+$/.test(str), true);
        });

        it('generates numeric string', () => {
            const str = randomStringSync(50, NumericCharacters);
            assert.strictEqual(/^[0-9]+$/.test(str), true);
        });
    });

    describe('Crypto class', () => {
        const mockConfig = {
            CRYPTO_SECRET: 'a'.repeat(32),
            CRYPTO_IV_LENGTH: 12
        };

        let CryptoClass: typeof Crypto;

        beforeEach(() => {
            resetSrcModuleCache();

            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const resolver = require('../../src/app/resolver');
            resolver.getAppConfig = () => mockConfig;

            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const cryptoModule = require('../../src/helpers/security/crypto');
            CryptoClass = cryptoModule.Crypto;
        });

        afterEach(() => {
            resetSrcModuleCache();
        });

        it('encrypts and decrypts string correctly', () => {
            const originalText = 'Hello, World!';
            const encrypted = CryptoClass.encrypt(originalText);
            assert.notStrictEqual(encrypted, originalText);
            assert.strictEqual(typeof encrypted, 'string');

            const decrypted = CryptoClass.decrypt(encrypted);
            assert.strictEqual(decrypted, originalText);
        });

        it('encrypts and decrypts buffer correctly', () => {
            const originalBuffer = Buffer.from('test data');
            const encrypted = CryptoClass.encrypt(originalBuffer);
            assert.strictEqual(Buffer.isBuffer(encrypted), true);
            assert.strictEqual(encrypted.equals(originalBuffer), false);

            const decrypted = CryptoClass.decrypt(encrypted);
            assert.strictEqual(Buffer.isBuffer(decrypted), true);
            assert.strictEqual(decrypted.equals(originalBuffer), true);
        });

        it('produces different ciphertext for same input', () => {
            const text = 'test';
            const encrypted1 = CryptoClass.encrypt(text);
            const encrypted2 = CryptoClass.encrypt(text);
            assert.notStrictEqual(encrypted1, encrypted2);

            assert.strictEqual(CryptoClass.decrypt(encrypted1), text);
            assert.strictEqual(CryptoClass.decrypt(encrypted2), text);
        });

        it('handles empty string', () => {
            const encrypted = CryptoClass.encrypt('');
            const decrypted = CryptoClass.decrypt(encrypted);
            assert.strictEqual(decrypted, '');
        });

        it('handles unicode characters', () => {
            const text = '你好世界 🌍 مرحبا';
            const encrypted = CryptoClass.encrypt(text);
            const decrypted = CryptoClass.decrypt(encrypted);
            assert.strictEqual(decrypted, text);
        });

        it('handles long strings', () => {
            const text = 'a'.repeat(10000);
            const encrypted = CryptoClass.encrypt(text);
            const decrypted = CryptoClass.decrypt(encrypted);
            assert.strictEqual(decrypted, text);
        });
    });

    describe('Character sets', () => {
        it('PrintableCharacters contains expected characters', () => {
            assert.strictEqual(PrintableCharacters.length, 95);
            assert.ok(PrintableCharacters.includes(' '));
            assert.ok(PrintableCharacters.includes('a'));
            assert.ok(PrintableCharacters.includes('~'));
        });

        it('AlphanumericCharacters contains only alphanumeric', () => {
            assert.strictEqual(/^[a-zA-Z0-9]+$/.test(AlphanumericCharacters), true);
            assert.strictEqual(AlphanumericCharacters.length, 62);
        });

        it('UpperCaseAlphanumericCharacters contains only uppercase', () => {
            assert.strictEqual(/^[A-Z0-9]+$/.test(UpperCaseAlphanumericCharacters), true);
            assert.strictEqual(UpperCaseAlphanumericCharacters.length, 36);
        });

        it('NumericCharacters contains only digits', () => {
            assert.strictEqual(NumericCharacters, '0123456789');
            assert.strictEqual(NumericCharacters.length, 10);
        });
    });
});
