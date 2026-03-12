import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getPackageJson, getPackageName, getPackageVersion } from '../../src/helpers/io/package';

describe('Package helpers', () => {
    describe('getPackageJson', () => {
        it('returns package.json object', () => {
            const pkg = getPackageJson();
            assert.notStrictEqual(pkg, undefined);
            assert.strictEqual(typeof pkg, 'object');
        });

        it('returns same object on multiple calls (memoized)', () => {
            const pkg1 = getPackageJson();
            const pkg2 = getPackageJson();
            assert.strictEqual(pkg1, pkg2);
        });

        it('contains expected fields', () => {
            const pkg = getPackageJson()!;
            assert.ok('name' in pkg);
            assert.ok('version' in pkg);
        });

        it('has correct package name', () => {
            const pkg = getPackageJson();
            assert.strictEqual(pkg?.name, '@zyno-io/dk-server-foundation');
        });

        it('has version field', () => {
            const pkg = getPackageJson();
            assert.notStrictEqual(pkg?.version, undefined);
            assert.strictEqual(typeof pkg?.version, 'string');
        });
    });

    describe('getPackageName', () => {
        it('returns package name', () => {
            const name = getPackageName();
            assert.strictEqual(name, '@zyno-io/dk-server-foundation');
        });

        it('returns same value on multiple calls', () => {
            const name1 = getPackageName();
            const name2 = getPackageName();
            assert.strictEqual(name1, name2);
        });

        it('returns string', () => {
            const name = getPackageName();
            assert.strictEqual(typeof name, 'string');
        });
    });

    describe('getPackageVersion', () => {
        it('returns package version', () => {
            const version = getPackageVersion();
            assert.notStrictEqual(version, undefined);
            assert.strictEqual(typeof version, 'string');
        });

        it('returns same value on multiple calls', () => {
            const version1 = getPackageVersion();
            const version2 = getPackageVersion();
            assert.strictEqual(version1, version2);
        });

        it('has valid version format', () => {
            const version = getPackageVersion();
            assert.notStrictEqual(version, undefined);
            // Version should be in format like "0.0.0-dev" or "1.2.3"
            assert.match(version!, /^\d+\.\d+\.\d+/);
        });
    });

    describe('consistency', () => {
        it('getPackageName matches getPackageJson name', () => {
            const pkg = getPackageJson();
            const name = getPackageName();
            assert.strictEqual(name, pkg?.name);
        });

        it('getPackageVersion matches getPackageJson version', () => {
            const pkg = getPackageJson();
            const version = getPackageVersion();
            assert.strictEqual(version, pkg?.version);
        });
    });
});
