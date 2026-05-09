import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AlterBlueprint, MySQLGrammar } from '../../../src';

describe('AlterBlueprint', () => {
    const grammar = new MySQLGrammar();

    it('records added columns via inherited type methods', () => {
        const t = new AlterBlueprint('users', grammar);
        t.string('phone', 20).nullable();
        t.boolean('active');
        assert.equal(t.addedColumns.length, 2);
        assert.equal(t.addedColumns[0].name, 'phone');
        assert.equal(t.addedColumns[1].name, 'active');
    });

    it('records drops, renames, and PK changes', () => {
        const t = new AlterBlueprint('users', grammar);
        t.dropColumn('legacy');
        t.renameColumn('old', 'new');
        t.dropIndex('users_email_unique');
        t.dropForeign('users_orgId_foreign');
        t.dropPrimary();
        t.primary(['a', 'b']);
        assert.deepEqual(t.droppedColumns, ['legacy']);
        assert.deepEqual(t.renamedColumns, [{ from: 'old', to: 'new' }]);
        assert.deepEqual(t.droppedIndexes, ['users_email_unique']);
        assert.deepEqual(t.droppedForeignKeys, ['users_orgId_foreign']);
        assert.equal(t.dropsPrimaryKey, true);
        assert.deepEqual(t.newPrimaryKey, ['a', 'b']);
    });

    it('.change() moves a column from added to modified', () => {
        const t = new AlterBlueprint('users', grammar);
        t.string('email', 500).notNull().change();
        assert.equal(t.addedColumns.length, 0, 'should have moved out of addedColumns');
        assert.equal(t.modifiedColumns.length, 1);
        assert.equal(t.modifiedColumns[0].name, 'email');
        assert.equal(t.modifiedColumns[0].size, 500);
    });

    it('mixes adds and modifications correctly', () => {
        const t = new AlterBlueprint('users', grammar);
        t.string('phone', 20); // add
        t.string('email', 500).notNull().change(); // modify
        t.boolean('active'); // add
        assert.equal(t.addedColumns.length, 2);
        assert.equal(t.modifiedColumns.length, 1);
        assert.deepEqual(
            t.addedColumns.map(c => c.name),
            ['phone', 'active']
        );
    });

    it('records added index/FK via inherited helpers', () => {
        const t = new AlterBlueprint('posts', grammar);
        t.index('slug');
        t.foreign('userId').references('id').on('users').onDelete('cascade');
        assert.equal(t.addedIndexes.length, 1);
        assert.equal(t.addedIndexes[0].name, 'posts_slug_index');
        assert.equal(t.addedForeignKeys.length, 1);
        assert.equal(t.addedForeignKeys[0].referencedTable, 'users');
    });
});
