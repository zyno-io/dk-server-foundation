import { deserialize } from '@deepkit/type';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { EMAIL_REGEX, TrimmedString } from '../../src';
import { PhoneNumber, PhoneNumberNANP } from '../../src/types/phone';
import { assertMatchObject } from '../shared/helpers';

it('properly validates email addresses', () => {
    assert.strictEqual(EMAIL_REGEX.test('test@example.com'), true);
    assert.strictEqual(EMAIL_REGEX.test('test+extras@example.com'), true);
    assert.strictEqual(EMAIL_REGEX.test('with_underscores@example.com'), true);
    assert.strictEqual(EMAIL_REGEX.test('and-hyphens@example.com'), true);
    assert.strictEqual(EMAIL_REGEX.test('test@example.com@example.com'), false);
    assert.strictEqual(EMAIL_REGEX.test('test@sgnl24'), false);
});

it('trims strings', () => {
    interface ITest {
        name: TrimmedString;
        words: string;
    }

    const result = deserialize<ITest>({ name: '  test  ', words: '  with leading spaces' });
    assertMatchObject(result, {
        name: 'test',
        words: '  with leading spaces'
    });
});

it('validates phone numbers', () => {
    interface ITest {
        phone: PhoneNumber;
    }

    {
        const result = deserialize<ITest>({ phone: '(404)-900-5600' });
        assertMatchObject(result, {
            phone: '+14049005600'
        });
    }

    {
        const result = deserialize<ITest>({ phone: '123.456.7890' /* not a valid number */ });
        assertMatchObject(result, {
            phone: '¡InvalidPhone¡'
        });
    }

    interface ITest2 {
        phone: PhoneNumberNANP;
    }
    {
        const result = deserialize<ITest2>({ phone: '(404)-900-5600' });
        assertMatchObject(result, {
            phone: '4049005600'
        });
    }
});
