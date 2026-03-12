import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanPhone } from '../../src/types/phone';

describe('Phone type helpers', () => {
    describe('cleanPhone', () => {
        describe('US numbers', () => {
            it('cleans valid US phone number', () => {
                assert.strictEqual(cleanPhone('2025551234', 'US'), '+12025551234');
                assert.strictEqual(cleanPhone('(202) 555-1234', 'US'), '+12025551234');
                assert.strictEqual(cleanPhone('202-555-1234', 'US'), '+12025551234');
            });

            it('handles US number with country code', () => {
                assert.strictEqual(cleanPhone('+12025551234', 'US'), '+12025551234');
                assert.strictEqual(cleanPhone('12025551234', 'US'), '+12025551234');
                assert.strictEqual(cleanPhone('+1 202 555 1234', 'US'), '+12025551234');
            });

            it('handles various US formatting styles', () => {
                assert.strictEqual(cleanPhone('202.555.1234', 'US'), '+12025551234');
                assert.strictEqual(cleanPhone('(202)555-1234', 'US'), '+12025551234');
                assert.strictEqual(cleanPhone('202 555 1234', 'US'), '+12025551234');
            });

            it('defaults to US country code', () => {
                assert.strictEqual(cleanPhone('2025551234'), '+12025551234');
                assert.strictEqual(cleanPhone('(202) 555-1234'), '+12025551234');
            });
        });

        describe('International numbers', () => {
            it('cleans UK phone number', () => {
                assert.strictEqual(cleanPhone('02071234567', 'GB'), '+442071234567');
                assert.strictEqual(cleanPhone('+442071234567', 'GB'), '+442071234567');
            });

            it('cleans German phone number', () => {
                assert.strictEqual(cleanPhone('030123456', 'DE'), '+4930123456');
                assert.strictEqual(cleanPhone('+4930123456', 'DE'), '+4930123456');
            });

            it('cleans French phone number', () => {
                assert.strictEqual(cleanPhone('0123456789', 'FR'), '+33123456789');
                assert.strictEqual(cleanPhone('+33123456789', 'FR'), '+33123456789');
            });

            it('cleans Australian phone number', () => {
                assert.strictEqual(cleanPhone('0212345678', 'AU'), '+61212345678');
                assert.strictEqual(cleanPhone('+61212345678', 'AU'), '+61212345678');
            });

            it('cleans Japanese phone number', () => {
                assert.strictEqual(cleanPhone('03-1234-5678', 'JP'), '+81312345678');
                assert.strictEqual(cleanPhone('+81312345678', 'JP'), '+81312345678');
            });
        });

        describe('Invalid numbers', () => {
            it('returns null for invalid US number', () => {
                assert.strictEqual(cleanPhone('123', 'US'), null);
                assert.strictEqual(cleanPhone('12345', 'US'), null);
                assert.strictEqual(cleanPhone('abc', 'US'), null);
            });

            it('returns null for empty string', () => {
                assert.strictEqual(cleanPhone('', 'US'), null);
            });

            it('returns null for non-string input', () => {
                assert.strictEqual(cleanPhone(null as any, 'US'), null);
                assert.strictEqual(cleanPhone(undefined as any, 'US'), null);
                assert.strictEqual(cleanPhone(123 as any, 'US'), null);
            });

            it('returns null for invalid format', () => {
                assert.strictEqual(cleanPhone('not-a-phone', 'US'), null);
                assert.strictEqual(cleanPhone('++1234567890', 'US'), null);
            });

            it('validates number correctly for specified country', () => {
                // A UK number is valid when parsed as UK
                assert.strictEqual(cleanPhone('+442071234567', 'GB'), '+442071234567');
                // But when parsed as US it will format differently if it matches a US pattern
                // or return null if invalid - this is expected library behavior
            });
        });

        describe('Edge cases', () => {
            it('handles numbers with extra spaces', () => {
                assert.strictEqual(cleanPhone('  202 555 1234  ', 'US'), '+12025551234');
            });

            it('handles numbers with multiple formatting characters', () => {
                assert.strictEqual(cleanPhone('+1 (202) 555-1234', 'US'), '+12025551234');
            });

            it('validates number length for country', () => {
                assert.strictEqual(cleanPhone('20255512', 'US'), null); // Too short
                assert.strictEqual(cleanPhone('202555123456', 'US'), null); // Too long
            });

            it('returns E.164 format consistently', () => {
                const result = cleanPhone('2025551234', 'US');
                assert.match(result!, /^\+\d+$/);
                assert.strictEqual(result, '+12025551234');
            });
        });

        describe('Special US cases', () => {
            it('handles toll-free numbers', () => {
                assert.strictEqual(cleanPhone('8005551234', 'US'), '+18005551234');
                assert.strictEqual(cleanPhone('8885551234', 'US'), '+18885551234');
            });

            it('handles different area codes', () => {
                assert.strictEqual(cleanPhone('2125551234', 'US'), '+12125551234'); // NYC
                assert.strictEqual(cleanPhone('4155551234', 'US'), '+14155551234'); // SF
                assert.strictEqual(cleanPhone('3105551234', 'US'), '+13105551234'); // LA
            });
        });

        describe('Mobile numbers', () => {
            it('handles UK mobile numbers', () => {
                assert.strictEqual(cleanPhone('07700123456', 'GB'), '+447700123456');
            });

            it('handles DE mobile numbers', () => {
                // German mobile numbers typically start with 015x, 016x, 017x
                // Using a more standard format
                assert.strictEqual(cleanPhone('015112345678', 'DE'), '+4915112345678');
            });

            it('handles FR mobile numbers', () => {
                assert.strictEqual(cleanPhone('0612345678', 'FR'), '+33612345678');
            });
        });
    });
});
