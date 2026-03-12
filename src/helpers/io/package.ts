import type { PackageJson } from 'type-fest';

import { readFileSync } from 'fs';
import { memoize } from 'lodash';
import { join } from 'path';
import { cwd } from 'process';

export const getPackageJson: () => PackageJson | undefined = memoize(() => {
    try {
        const pkgJsonStr = readFileSync(join(cwd(), 'package.json'), 'utf8');
        const pkgJson = JSON.parse(pkgJsonStr);
        return pkgJson;
        // eslint-disable-next-line unused-imports/no-unused-vars
    } catch (err) {
        return undefined;
    }
});

export function getPackageVersion() {
    const pkgJson = getPackageJson();
    return pkgJson?.version;
}

export function getPackageName() {
    const pkgJson = getPackageJson();
    return pkgJson?.name;
}
