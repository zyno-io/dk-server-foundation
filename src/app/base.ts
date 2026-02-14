import { App, AppModule, RootModuleDefinition } from '@deepkit/app';
import { ClassType } from '@deepkit/core';
import { eventDispatcher } from '@deepkit/event';
import { BrokerConfig, FrameworkConfig, FrameworkModule, onServerBootstrapDone, onServerMainBootstrapDone, RpcServer } from '@deepkit/framework';
import { HttpKernel, HttpListener, HttpModule } from '@deepkit/http';
import { InjectorModule, ProviderWithScope, Token } from '@deepkit/injector';
import { ConsoleTransport, Logger } from '@deepkit/logger';
import { DatabaseRegistry } from '@deepkit/orm';

import { BaseDatabase } from '../database';
import { replaceMigrationCommands } from '../database/migration';
import { getMigrationsDir } from '../database/migration/helpers';
import { HealthModule } from '../health/health.module';
import { HealthcheckService } from '../health/healthcheck.service';
import { createSymbolAttachmentClassDecorator } from '../helpers/framework/decorators';
import { CustomHttpKernel, HttpWorkflowListener, HttpWorkflowListenerOptions } from '../http';
import { HttpCorsListener, HttpCorsOptions, HttpCorsOptionsMulti } from '../http/cors';
import { ExtendedLogger, MailService, WorkerService } from '../services';
import { ProviderInvokeCommand } from '../services/cli/invoke';
import { ReplCommand } from '../services/cli/repl';
import { installWorkerComponents } from '../services/worker/bootstrap';
import { flushSentry, installSentry } from '../telemetry/sentry';
import { BaseAppConfig } from './config';
import { CustomConfigLoader } from './config.loader';
import { isDevelopment, isTest } from './const';
import { doDevPostAppStartup } from './dev';
import { ShutdownListener } from './shutdown';
import { DBProvider, globalState } from './state';
import { r } from './resolver';

export interface CreateAppOptions<C extends BaseAppConfig> extends RootModuleDefinition {
    config: ClassType<C>;
    defaultConfig?: Partial<C>;
    db?: ClassType<BaseDatabase>;
    frameworkConfig?: Partial<FrameworkConfig>;
    cors?: (config: C) => HttpCorsOptions | HttpCorsOptions[];
    enableWorker?: boolean;
    enableDkRpc?: boolean;
}
// todo: figure out why the type won't pass through without conflict
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApp<T extends CreateAppOptions<any>>(options: T) {
    const { config, defaultConfig, db, frameworkConfig, cors: corsOptionsFactory, ...appOptions } = options;

    const frameworkModule = new FrameworkModule({
        port: 3000,
        migrationDir: getMigrationsDir(),
        httpLog: false, // don't use the default - we'll roll out own
        gracefulShutdownTimeout: 30,

        ...frameworkConfig,

        broker: {
            ...new BrokerConfig(),
            startOnBootstrap: false,
            ...frameworkConfig?.broker
        },
        http: {
            ...frameworkConfig?.http,
            parser: {
                multipartJsonKey: '_payload',
                ...frameworkConfig?.http?.parser
            }
        }
    });

    frameworkModule.getImportedModuleByClass(HttpModule).addProvider({ provide: HttpKernel, useClass: CustomHttpKernel });

    const app = new App({
        ...appOptions,
        config: config,
        controllers: [ReplCommand, ProviderInvokeCommand, ...(appOptions.controllers ?? [])],
        imports: [...(appOptions.imports ?? []), frameworkModule, new HealthModule()],
        providers: [
            HttpListener,
            HttpWorkflowListenerOptions,
            WorkerService,
            MailService,
            ...(appOptions.providers ?? []),
            ...(db ? [db] : []),
            ...(appOptions.enableDkRpc ? [] : [{ provide: RpcServer, useValue: { start: () => {} } }])
        ],
        listeners: [HttpWorkflowListener, ShutdownListener, ...(appOptions.listeners ?? [])]
    });

    globalState.currentApp = app;

    replaceMigrationCommands(app, frameworkModule, db);

    if (options.config) {
        app.appModule.addProvider({
            provide: options.config,
            useFactory() {
                return app.appModule.config;
            }
        });
        app.appModule.addProvider({
            provide: BaseAppConfig,
            useExisting: options.config
        });

        app.addConfigLoader(new CustomConfigLoader(defaultConfig));

        // reconfigure the framework module to use the port from the config
        app.setup((module, config) => {
            if (config.PORT && !isTest) {
                module.getImportedModuleByClass(FrameworkModule).configure({
                    port: config.PORT
                });
            }
        });
    }

    if (options.db) {
        app.appModule.addProvider({
            provide: DBProvider,
            useFactory() {
                return new DBProvider(app.get(options.db));
            }
        });

        class DBHealthSetupListener {
            constructor(private hcSvc: HealthcheckService) {}

            @eventDispatcher.listen(onServerBootstrapDone)
            onServerBootstrapDone() {
                const db = app.get(options.db);
                this.hcSvc.register(async () => {
                    await db.rawFind('SELECT 1');
                });
            }
        }
        app.appModule.addListener(DBHealthSetupListener);
    }

    if (corsOptionsFactory) {
        app.appModule.addProvider({
            provide: HttpCorsOptionsMulti,
            useFactory(): HttpCorsOptionsMulti {
                const options = corsOptionsFactory(app.appModule.config);
                return new HttpCorsOptionsMulti(Array.isArray(options) ? options : [options]);
            }
        });

        app.appModule.addListener(HttpCorsListener);
    }

    // hijack the Logger injection to replace the factory with ExtendedLogger
    // this is definitely not a good way to do this
    const originalProcessProviderFn = app.appModule.processProvider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.appModule.processProvider = function (module: AppModule<any>, token: Token, provider: ProviderWithScope) {
        if (token === Logger) {
            if (typeof provider === 'object' && 'useFactory' in provider) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (provider as any).useFactory;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (provider as any).useClass = ExtendedLogger;
            }
        }
        return originalProcessProviderFn.call(this, module, token, provider);
    };

    // Allow direct injection of ExtendedLogger by aliasing it to Logger
    app.appModule.addProvider({
        provide: ExtendedLogger,
        useExisting: Logger
    });

    if (options.enableWorker) {
        installWorkerComponents(app);
    }

    let started = false;
    app.listen(onServerMainBootstrapDone, () => {
        started = true;
        doAppPostStartup(app, !!options.db);
    });

    app.setup((_module, config) => {
        if (config.SENTRY_DSN) {
            installSentry({
                dsn: config.SENTRY_DSN
            });
        }
    });

    const makeErrorHandler = (type: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (err: any, promise?: any) => {
            const logger = started ? r(Logger) : new Logger([new ConsoleTransport()]);
            logger.error(type, err, { promise });
            flushSentry()
                .catch(err => logger.error('Error flushing to Sentry', err))
                .finally(() => process.exit(1));
        };
    };
    process.on('uncaughtException', makeErrorHandler('uncaughtException'));
    process.on('unhandledRejection', makeErrorHandler('unhandledRejection'));

    return app;
}

const AutoStartSymbol = Symbol('AutoStart');
export const AutoStart = createSymbolAttachmentClassDecorator(AutoStartSymbol);

async function doAppPostStartup<T extends RootModuleDefinition>(app: App<T>, enableDb?: boolean) {
    if (enableDb) {
        // DK lazily starts the database registry, but we don't have any calls that
        // would cause that. without the registry, the application shutdown hook to
        // disconect from the database is never executed. thus, we'll invoke this manually.
        app.get(DatabaseRegistry).init();
    }

    // let's do some things when we're running normally (not as a CLI service)
    if (!globalState.isCliService) {
        // there are cases where we want a provider to start automatically at application startup,
        // rather than waiting for injection via DI -- such as services that connect to 3rd parties
        // via sockets to process events.
        createAutoStartInstances(app.appModule);

        // development only
        if (isDevelopment) {
            doDevPostAppStartup(app);
        }
    }
}

async function createAutoStartInstances(aModule: InjectorModule) {
    const injector = aModule.injector;

    if (aModule.imports?.length) {
        for (const anImport of aModule.imports) {
            await createAutoStartInstances(anImport);
        }
    }

    for (const provider of aModule.providers) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((provider as any)[AutoStartSymbol]) {
            injector?.get(provider);
        }
    }
}
