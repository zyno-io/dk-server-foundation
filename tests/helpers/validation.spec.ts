import { HttpBadRequestError } from '@deepkit/http';
import { ValidationError } from '@deepkit/type';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertInput, validateOrThrow } from '../../src/helpers/security/validation';

describe('Validation helpers', () => {
    describe('validateOrThrow', () => {
        interface TestType {
            name: string;
            age: number;
        }

        it('returns true for valid data', () => {
            const data = { name: 'John', age: 30 };
            assert.strictEqual(validateOrThrow<TestType>(data), true);
        });

        it('throws ValidationError for invalid data', () => {
            const data = { name: 'John', age: 'invalid' };
            assert.throws(() => validateOrThrow<TestType>(data), ValidationError);
        });

        it('validates string type', () => {
            const data = 'test string';
            assert.strictEqual(validateOrThrow<string>(data), true);
        });

        it('validates number type', () => {
            const data = 42;
            assert.strictEqual(validateOrThrow<number>(data), true);
        });

        it('validates array type', () => {
            const data = [1, 2, 3];
            assert.strictEqual(validateOrThrow<number[]>(data), true);
        });

        it('validates nested objects', () => {
            interface NestedType {
                user: {
                    name: string;
                    email: string;
                };
            }
            const data = {
                user: {
                    name: 'Alice',
                    email: 'alice@example.com'
                }
            };
            assert.strictEqual(validateOrThrow<NestedType>(data), true);
        });

        it('acts as type guard', () => {
            const data: any = { name: 'John', age: 30 };
            if (validateOrThrow<TestType>(data)) {
                // TypeScript should know data is TestType here
                assert.strictEqual(data.name, 'John');
                assert.strictEqual(data.age, 30);
            }
        });
    });

    describe('assertInput', () => {
        it('does not throw for truthy values', () => {
            assert.doesNotThrow(() => assertInput('value'));
            assert.doesNotThrow(() => assertInput(123));
            assert.doesNotThrow(() => assertInput(true));
            assert.doesNotThrow(() => assertInput({}));
            assert.doesNotThrow(() => assertInput([]));
        });

        it('throws HttpBadRequestError for undefined', () => {
            assert.throws(() => assertInput(undefined), HttpBadRequestError);
            assert.throws(() => assertInput(undefined), { message: 'missing parameters' });
        });

        it('throws HttpBadRequestError for null', () => {
            assert.throws(() => assertInput(null), HttpBadRequestError);
            assert.throws(() => assertInput(null), { message: 'missing parameters' });
        });

        it('includes field name in error message when provided', () => {
            assert.throws(() => assertInput(undefined, 'username'), { message: 'username is required' });
            assert.throws(() => assertInput(null, 'email'), { message: 'email is required' });
        });

        it('allows falsy values that are not null or undefined', () => {
            assert.doesNotThrow(() => assertInput(0));
            assert.doesNotThrow(() => assertInput(''));
            assert.doesNotThrow(() => assertInput(false));
        });

        it('acts as assertion for TypeScript', () => {
            const value: string | undefined = 'test';
            assertInput(value);
            // TypeScript should know value is defined here
            assert.strictEqual(value.length, 4);
        });

        it('can be chained for multiple validations', () => {
            const data = {
                name: 'John',
                email: 'john@example.com',
                age: 30
            };

            assert.doesNotThrow(() => {
                assertInput(data.name, 'name');
                assertInput(data.email, 'email');
                assertInput(data.age, 'age');
            });
        });

        it('stops at first missing field', () => {
            const data = {
                name: 'John',
                email: undefined
            };

            assert.throws(
                () => {
                    assertInput(data.name, 'name');
                    assertInput(data.email, 'email');
                },
                { message: 'email is required' }
            );
        });
    });
});
