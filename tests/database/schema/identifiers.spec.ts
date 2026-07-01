import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultBlueprintIdentifierName, defaultEntityIndexName, maxIdentifierLength, normalizeGeneratedIdentifier } from '../../../src';

describe('schema identifier helpers', () => {
    it('leaves generated identifiers unchanged when they are within the dialect limit', () => {
        assert.equal(normalizeGeneratedIdentifier('users_email_index', 'mysql'), 'users_email_index');
        assert.equal(defaultBlueprintIdentifierName('users', ['email'], 'index', 'postgres'), 'users_email_index');
    });

    it('shortens generated MySQL identifiers with a stable hash', () => {
        const original = 'idx_sales_predefinedDiscountTypes_products_predefinedDiscountTypeId';
        const name = defaultEntityIndexName('sales_predefinedDiscountTypes_products', ['predefinedDiscountTypeId'], 'mysql');

        assert.equal(original.length, 67);
        assert.equal(name.length, maxIdentifierLength('mysql'));
        assert.notEqual(name, original);
        assert.match(name, /^idx_sales_/);
        assert.match(name, /_[0-9a-f]{8}_/);
        assert.match(name, /DiscountTypeId$/);
        assert.equal(defaultEntityIndexName('sales_predefinedDiscountTypes_products', ['predefinedDiscountTypeId'], 'mysql'), name);
    });

    it('uses the Postgres identifier limit for generated names', () => {
        const name = defaultBlueprintIdentifierName(
            'a_very_long_table_name_for_identifier_limit_tests',
            ['a_very_long_column_name'],
            'index',
            'postgres'
        );

        assert.ok(name.length <= maxIdentifierLength('postgres'));
        assert.match(name, /_[0-9a-f]{8}_/);
    });
});
