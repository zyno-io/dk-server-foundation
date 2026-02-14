import { DatabaseRegistry } from '@deepkit/orm';

import { getAppModule, getOrCreateInjectorForModule, r } from '../../app/resolver';
import { getProviderTree } from '../../helpers/framework/injection';

export interface ReplContext {
    /** Class providers (access via $.ClassName) */
    classProvider: Record<string, unknown>;
    /** Instance providers (access via $$.InstanceName) — lazily resolved from DI */
    instanceProvider: Record<string, unknown>;
}

/**
 * Build the REPL context with `$` (class providers) and `$$` (instance providers + entity classes).
 * Also sets `global.$` and `global.$$` for use in eval contexts.
 */
export function buildReplContext(): ReplContext {
    const databaseRegistry = r(DatabaseRegistry);
    databaseRegistry.init();

    const providers = getProviderTree(getAppModule());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const classProvider: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instanceProvider: any = {};

    for (const provider of providers) {
        if (!(provider.name in classProvider)) {
            Object.defineProperty(classProvider, provider.name, {
                get() {
                    return provider.provide;
                }
            });
        }

        if (!(provider.name in instanceProvider)) {
            Object.defineProperty(instanceProvider, provider.name, {
                get() {
                    const injector = getOrCreateInjectorForModule(provider.module);
                    return injector.get(provider.provide);
                }
            });
        }
    }

    for (const database of databaseRegistry.getDatabases()) {
        for (const entity of database.entityRegistry.all()) {
            Object.defineProperty(instanceProvider, entity.type.typeName!, {
                get() {
                    return entity.getClassType();
                }
            });
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).$ = classProvider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).$$ = instanceProvider;

    return { classProvider, instanceProvider };
}
