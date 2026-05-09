import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MySQLGrammar, PostgresGrammar } from '../../../src';
import { ColumnSchema } from '../../../src/database/migration/create/schema-model';

const col = (overrides: Partial<ColumnSchema>): ColumnSchema => ({
    name: 'col',
    type: 'varchar',
    size: 100,
    unsigned: false,
    nullable: false,
    autoIncrement: false,
    isPrimaryKey: false,
    ordinalPosition: 1,
    ...overrides
});

describe('MySQLGrammar — alter ops', () => {
    const g = new MySQLGrammar();

    it('addColumn emits ALTER TABLE ADD COLUMN', () => {
        assert.equal(g.addColumn('users', col({ name: 'phone', size: 20 })), 'ALTER TABLE `users` ADD COLUMN `phone` VARCHAR(20) NOT NULL');
    });

    it('dropColumn', () => {
        assert.equal(g.dropColumn('users', 'legacy'), 'ALTER TABLE `users` DROP COLUMN `legacy`');
    });

    it('modifyColumn returns a single MODIFY COLUMN statement', () => {
        const stmts = g.modifyColumn('users', col({ name: 'email', size: 500, nullable: true }));
        assert.deepEqual(stmts, ['ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(500)']);
    });

    it('renameColumn uses RENAME COLUMN', () => {
        assert.equal(g.renameColumn('users', 'old', 'new'), 'ALTER TABLE `users` RENAME COLUMN `old` TO `new`');
    });

    it('dropIndex uses DROP INDEX ... ON table', () => {
        assert.equal(g.dropIndex('users', 'users_email_unique'), 'DROP INDEX `users_email_unique` ON `users`');
    });

    it('dropForeignKey uses DROP FOREIGN KEY', () => {
        assert.equal(g.dropForeignKey('posts', 'posts_userId_foreign'), 'ALTER TABLE `posts` DROP FOREIGN KEY `posts_userId_foreign`');
    });

    it('addPrimaryKey + dropPrimaryKey', () => {
        assert.equal(g.addPrimaryKey('t', ['a', 'b']), 'ALTER TABLE `t` ADD PRIMARY KEY (`a`, `b`)');
        assert.equal(g.dropPrimaryKey('t'), 'ALTER TABLE `t` DROP PRIMARY KEY');
    });
});

describe('PostgresGrammar — alter ops', () => {
    const g = new PostgresGrammar();
    const gNS = new PostgresGrammar('myschema');

    it('addColumn', () => {
        assert.equal(g.addColumn('users', col({ name: 'phone', size: 20 })), 'ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NOT NULL');
    });

    it('dropColumn', () => {
        assert.equal(g.dropColumn('users', 'legacy'), 'ALTER TABLE "users" DROP COLUMN "legacy"');
    });

    it('modifyColumn emits TYPE + nullability + DEFAULT statements', () => {
        const stmts = g.modifyColumn('users', col({ name: 'email', size: 500, nullable: true }));
        assert.equal(stmts.length, 3);
        assert.equal(stmts[0], 'ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(500)');
        assert.equal(stmts[1], 'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL');
        assert.equal(stmts[2], 'ALTER TABLE "users" ALTER COLUMN "email" DROP DEFAULT');
    });

    it('modifyColumn SET NOT NULL + SET DEFAULT', () => {
        const stmts = g.modifyColumn('t', col({ name: 'x', defaultValue: 'hi' }));
        assert.match(stmts[1], /SET NOT NULL/);
        assert.match(stmts[2], /SET DEFAULT 'hi'/);
    });

    it('modifyColumn for boolean default', () => {
        const stmts = g.modifyColumn('t', col({ name: 'active', type: 'boolean', defaultValue: false }));
        assert.match(stmts[2], /SET DEFAULT FALSE/);
    });

    it('renameColumn', () => {
        assert.equal(g.renameColumn('users', 'old', 'new'), 'ALTER TABLE "users" RENAME COLUMN "old" TO "new"');
    });

    it('dropIndex (no ALTER TABLE)', () => {
        assert.equal(g.dropIndex('users', 'users_email_unique'), 'DROP INDEX "users_email_unique"');
    });

    it('dropIndex with non-public schema', () => {
        assert.equal(gNS.dropIndex('users', 'i'), 'DROP INDEX "myschema"."i"');
    });

    it('dropForeignKey uses DROP CONSTRAINT', () => {
        assert.equal(g.dropForeignKey('posts', 'posts_userId_foreign'), 'ALTER TABLE "posts" DROP CONSTRAINT "posts_userId_foreign"');
    });

    it('addPrimaryKey + dropPrimaryKey', () => {
        assert.equal(g.addPrimaryKey('t', ['a', 'b']), 'ALTER TABLE "t" ADD PRIMARY KEY ("a", "b")');
        assert.equal(g.dropPrimaryKey('t'), 'ALTER TABLE "t" DROP CONSTRAINT "t_pkey"');
        assert.equal(g.dropPrimaryKey('t', 'custom_pk'), 'ALTER TABLE "t" DROP CONSTRAINT "custom_pk"');
    });
});
