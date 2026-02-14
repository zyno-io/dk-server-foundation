import { App } from '@deepkit/app';
import { FrameworkModule } from '@deepkit/framework';
import { HttpRouter } from '@deepkit/http';
import { Logger, ScopedLogger } from '@deepkit/logger';
import { ReflectionKind } from '@deepkit/type';
import { OpenAPIDocument } from 'deepkit-openapi-core';
import { writeFile } from 'fs/promises';
import path from 'path';
import { stringify } from 'yaml';

import { createLogger } from '../services';
import { getAppConfig } from './resolver';
import { isDevFeatureEnabled } from './config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function doDevPostAppStartup(app: App<any>) {
    try {
        const { DevConsoleStore } = await import('../devconsole/devconsole.store');
        const store = DevConsoleStore.get();
        if (store) {
            const { DevConsoleSrpcServer } = await import('../devconsole/devconsole.ws');
            const srpcServer = new DevConsoleSrpcServer(createLogger('DevConsole'));
            store.onEvent = (type, data) => srpcServer.broadcast(type, data);
        }
    } catch (err) {
        const logger = app.get(Logger);
        logger.warn('Failed to start DevConsole SRPC server', err);
    }

    // this hook seems to run before the router even outputs HTTP routes, which means
    // anything we output is hard for the developer to see. thus, we will run dev tooling
    // with a delay.
    setTimeout(() => doDelayedDevPostAppStartup(app), 250);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function doDelayedDevPostAppStartup(app: App<any>) {
    const config = getAppConfig();

    logRoutesWithoutReturnType(app);

    if (isDevFeatureEnabled(config.ENABLE_OPENAPI_SCHEMA)) {
        dumpOpenApiSchema(app);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logRoutesWithoutReturnType(app: App<any>) {
    const router = app.get(HttpRouter);
    const logger = app.get(Logger);
    const routes = router.getRoutes();
    for (const route of routes) {
        if (!(route.action.module instanceof FrameworkModule)) {
            if (!route.returnType || route.returnType.kind === ReflectionKind.any) {
                let message = `No return type declared for ${route.httpMethods.join(',')} ${route.getFullPath()}`;
                if (route.action.type === 'controller') {
                    message += ` (${route.action.controller.name} -> ${route.action.methodName})`;
                }
                logger.warn(message);
            } else if (route.returnType.typeName === 'RedirectResponse' && !route.responses.length) {
                route.responses.push({ statusCode: 302, description: '' });
            } else if (route.returnType.typeName === 'EmptyResponse' && !route.responses.length) {
                route.responses.push({ statusCode: 202, description: '' });
            }
        }
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeOpenApiSchema(app: App<any>) {
    const router = app.get(HttpRouter);
    const logger = app.get(Logger) as unknown as ScopedLogger;
    const routes = router.getRoutes().filter(r => !r.getFullPath().startsWith('/_devconsole'));
    const doc = new OpenAPIDocument(routes, logger, { contentTypes: ['application/json'] });
    return doc.serializeDocument();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dumpOpenApiSchema(app: App<any>) {
    const logger = app.get(Logger);
    try {
        const result = serializeOpenApiSchema(app);
        const yaml = stringify(result, {
            aliasDuplicateObjects: false
        });
        const yamlPath = path.join(process.cwd(), 'openapi.yaml');
        await writeFile(yamlPath, yaml);
        logger.info(`OpenAPI schema written to: ${yamlPath}`);
    } catch (err) {
        logger.error(`Failed to write OpenAPI schema`, err);
    }
}
