import { serialize } from '@deepkit/type';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, EntityFields } from '../../src';

class TestEntity extends BaseEntity {
    id: number = 0;
    name: string = '';
    age: number = 0;
    createdAt: Date = new Date('2024-01-01T00:00:00Z');
}
type TestEntityFields = EntityFields<TestEntity>;

describe('Type', () => {
    it('properly serializes entity fields', () => {
        const a = new TestEntity();
        const result = serialize<TestEntityFields>(a);
        assert.deepStrictEqual(result, { id: 0, name: '', age: 0, createdAt: '2024-01-01T00:00:00.000Z' });
    });
});
