import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer } from '../../src/devconsole/devconsole.store';

describe('RingBuffer', () => {
    it('starts empty', () => {
        const buf = new RingBuffer<number>(5);
        assert.strictEqual(buf.length, 0);
        assert.deepStrictEqual(buf.toArray(), []);
    });

    it('pushes items within capacity', () => {
        const buf = new RingBuffer<number>(5);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        assert.strictEqual(buf.length, 3);
        assert.deepStrictEqual(buf.toArray(), [1, 2, 3]);
    });

    it('fills to exact capacity', () => {
        const buf = new RingBuffer<number>(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        assert.strictEqual(buf.length, 3);
        assert.deepStrictEqual(buf.toArray(), [1, 2, 3]);
    });

    it('wraps around and overwrites oldest items', () => {
        const buf = new RingBuffer<number>(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        buf.push(4); // overwrites 1
        assert.strictEqual(buf.length, 3);
        assert.deepStrictEqual(buf.toArray(), [2, 3, 4]);
    });

    it('handles multiple wrap-arounds', () => {
        const buf = new RingBuffer<number>(3);
        for (let i = 1; i <= 10; i++) {
            buf.push(i);
        }
        assert.strictEqual(buf.length, 3);
        assert.deepStrictEqual(buf.toArray(), [8, 9, 10]);
    });

    it('capacity of 1 always returns last item', () => {
        const buf = new RingBuffer<string>(1);
        buf.push('a');
        assert.deepStrictEqual(buf.toArray(), ['a']);
        buf.push('b');
        assert.deepStrictEqual(buf.toArray(), ['b']);
        buf.push('c');
        assert.strictEqual(buf.length, 1);
        assert.deepStrictEqual(buf.toArray(), ['c']);
    });

    it('preserves insertion order after wrap', () => {
        const buf = new RingBuffer<number>(4);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        buf.push(4);
        buf.push(5); // overwrites 1, head moves to index 1
        buf.push(6); // overwrites 2, head moves to index 2
        // buffer: [5, 6, 3, 4], head=2, oldest is at index 2
        assert.deepStrictEqual(buf.toArray(), [3, 4, 5, 6]);
    });

    it('works with object types', () => {
        const buf = new RingBuffer<{ id: number }>(2);
        const a = { id: 1 };
        const b = { id: 2 };
        const c = { id: 3 };
        buf.push(a);
        buf.push(b);
        buf.push(c);
        assert.deepStrictEqual(buf.toArray(), [b, c]);
    });
});
