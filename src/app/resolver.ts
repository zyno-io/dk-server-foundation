import { ClassType } from '@deepkit/core';
import { Injector, InjectorModule } from '@deepkit/injector';

import { BaseAppConfig } from './config';
import { globalState } from './state';

const resolveCache = new WeakMap();
export function resolve<T>(type: ClassType<T>): T {
    const cached = resolveCache.get(type);
    if (cached) return cached;

    const app = globalState.currentApp;
    if (!app) throw new Error('No app initialized');
    const resolved = app.get(type);
    resolveCache.set(type, resolved);
    return resolved as T;
}

export const r = resolve;

export function resolveDeep<T>(type: ClassType<T>, fromModule: InjectorModule = getAppModule()): T | undefined {
    if (fromModule.isProvided(type)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return getOrCreateInjectorForModule(fromModule).get(type as any);
    }

    if (fromModule.imports?.length) {
        for (const anImport of fromModule.imports) {
            const result = resolveDeep(type, anImport);
            if (result) return result;
        }
    }
}

export function getOrCreateInjectorForModule(module: InjectorModule): Injector {
    return globalState.currentApp!.getInjectorContext().getInjector(module);
}

export function getApp() {
    if (!globalState.currentApp) throw new Error('No app initialized');
    return globalState.currentApp;
}

export function getAppModule() {
    return getApp().appModule;
}

export function getAppConfig() {
    return getAppModule().config as BaseAppConfig;
}
