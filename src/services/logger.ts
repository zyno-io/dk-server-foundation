import { ClassType } from '@deepkit/core';
import { DefaultFormatter, LogData, Logger, LoggerFormatter, LoggerLevel } from '@deepkit/logger';
import { DatabaseError } from '@deepkit/orm';
import { AxiosError, isAxiosError } from 'axios';
import debug from 'debug';
import { pino, stdTimeFunctions } from 'pino';

import { isDevFeatureEnabled } from '../app/config';
import { isDevelopment, isTest } from '../app/const';
import { DecoratedError, getContext, isError, reportError, withContextData } from '../helpers';
import { r } from '../app/resolver';

export const shouldUsePinoPretty = isDevFeatureEnabled(process.env.ENABLE_PINO_PRETTY);
export const shouldUseSingleLine = isDevFeatureEnabled(process.env.ENABLE_PINO_SINGLE_LINE);
export const LoggerContextProps: string[] = ['http', 'job'];
export const LoggerContextSymbol = Symbol('LoggerContext');

const PinoSeverityMap = {
    [LoggerLevel.none]: 'DEFAULT',
    [LoggerLevel.alert]: 'ALERT',
    [LoggerLevel.error]: 'ERROR',
    [LoggerLevel.warning]: 'WARNING',
    [LoggerLevel.log]: 'NOTICE',
    [LoggerLevel.info]: 'INFO',
    [LoggerLevel.debug]: 'DEBUG',
    [LoggerLevel.debug2]: 'DEBUG'
} as const;
type Severity = (typeof PinoSeverityMap)[keyof typeof PinoSeverityMap];
const InvertedPinoSeverityMap: Record<Severity, number> = {
    DEFAULT: LoggerLevel.none,
    ALERT: LoggerLevel.alert,
    ERROR: LoggerLevel.error,
    WARNING: LoggerLevel.warning,
    NOTICE: LoggerLevel.log,
    INFO: LoggerLevel.info,
    DEBUG: LoggerLevel.debug
} as const;

const logStream = shouldUsePinoPretty
    ? (() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const PinoPretty = require('pino-pretty');
          return PinoPretty.default({
              colorize: true,
              singleLine: shouldUseSingleLine,
              messageFormat: '\x1b[35m{scope} \x1b[36m{message}',
              ignore: 'scope',
              level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
              levelFirst: true,
              levelKey: 'severity',
              customLevels: Object.entries(InvertedPinoSeverityMap)
                  .map(([severity, level]) => `${severity}:${level}`)
                  .join(','),
              messageKey: 'message',
              customColors: 'alert:bgRed,error:red,warning:yellow,notice:green,info:blue,debug:gray,default:white',
              sync: isTest
          });
      })()
    : undefined;

export const pinoLogger = pino(
    {
        formatters: {
            level: label => ({ severity: label }),
            bindings: isDevelopment ? () => ({ pid: process.pid }) : () => ({})
        },
        timestamp: stdTimeFunctions.isoTime,
        messageKey: 'message',
        customLevels: InvertedPinoSeverityMap,
        useOnlyCustomLevels: true,
        level: 'DEFAULT'
    },
    logStream
);

export class ExtendedLogger extends Logger {
    protected scopeData?: LogData;

    addFormatter(formatter: LoggerFormatter): void {
        // - the server:start command injects DefaultFormatter after logger is instantiated
        // - the message that's transformed by DefaultFormatter is not used by the default JSON transport
        // - the color remover only removes colors from the prop the JSON transport *isn't* using
        // so don't allow the default formatter to be added, then use our custom JSON formatter
        // to read the original message prop after the color has been stripped
        if (formatter instanceof DefaultFormatter) {
            return;
        }

        super.addFormatter(formatter);
    }

    scoped(shortName: string, data?: LogData): ExtendedLogger {
        const name = this.scope.length ? `${this.scope}:${shortName}` : shortName;

        // If data is provided, always create a new instance to avoid sharing scopeData
        // between different callers (e.g., different SIP dialogs with different callIds)
        if (data) {
            const scoped = new ExtendedLogger(this.transporter, this.formatter, name);
            scoped.level = this.level;
            // Inherit parent's scopeData and merge with provided data
            scoped.scopeData = { ...this.scopeData, ...data };
            return scoped;
        }

        // For bare scoped loggers (no data), use caching
        if (!this.scopes[name]) {
            const scoped = new ExtendedLogger(this.transporter, this.formatter, name);
            scoped.level = this.level;
            if (this.scopeData) {
                scoped.scopeData = { ...this.scopeData };
            }
            this.scopes[name] = scoped;
        }

        return this.scopes[name] as ExtendedLogger;
    }

    // the first parameter can be a string or an object
    // if the first parameter is a string, the second can be an object
    // any funkier configurations than that, and we start stuffing indexed args onto the data object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected send(messages: any[], level: LoggerLevel, data?: LogData) {
        let err = isError(messages[0]) ? messages.shift() : isError(messages[1]) ? messages.splice(1, 1).shift() : undefined;
        const message = typeof messages[0] === 'string' ? messages.shift() : '';
        if (messages.length === 1 && typeof messages[0] === 'object') {
            data = Object.assign(data ?? {}, messages[0]);
        } else if (messages.length) {
            data = data || {};
            messages.forEach((msg, idx) => {
                data![`arg${idx}`] = msg;
            });
        } else {
            data = undefined;
        }

        if (!err && data && 'err' in data) {
            err = data.err;
            delete data.err;
        }

        if (this.scopeData) {
            data = Object.assign(data ?? {}, this.scopeData);
        }

        const strippedMessage = this.stripColors(message);

        // clean up errors that are too large and don't provide value to us
        if (err instanceof DatabaseError) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (err as any).entity;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (err as any).classSchema;
        } else if (isAxiosError(err)) {
            err = transformAxiosError(err);
        }

        pinoLogger[PinoSeverityMap[level]](
            {
                ...(err && { err }),
                ...(this.scope && { scope: this.scope }),
                ...data,
                ...this.getContextProps()
            },
            strippedMessage
        );

        if (err || level === LoggerLevel.alert || level === LoggerLevel.error) {
            this.handleError(level, strippedMessage, err, data);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug(...message: any[]): void {
        if (!debug(this.scope).enabled) return;
        this.send(message, LoggerLevel.debug);
    }

    getContextProps() {
        const context = getContext();
        if (!context) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: [string, any][] = [];
        for (const prop of LoggerContextProps) {
            if (context[prop]) {
                entries.push([prop, context[prop]]);
            }
        }
        if (context[LoggerContextSymbol]) {
            for (const [key, value] of Object.entries(context[LoggerContextSymbol])) {
                entries.push([key, value]);
            }
        }
        if (!entries.length) return;

        return Object.fromEntries(entries);
    }

    stripColors(message: string) {
        return message.includes('<') ? message.replace(/<(\/)?([a-zA-Z]+)>/g, '') : message;
    }

    setScopeData(data?: LogData) {
        this.scopeData = data;
        return this;
    }

    handleError(level: LoggerLevel, message: string | undefined, err: Error | undefined, data: LogData | undefined): void {
        const resolvedErr = message && message !== 'Controller error' ? new Error(message) : (err ?? new Error('Unknown error'));
        (resolvedErr as DecoratedError).cause = resolvedErr !== err ? err : undefined;
        reportError(level, resolvedErr, {
            data,
            scope: this.scope || undefined,
            scopeData: this.scopeData,
            ...this.getContextProps()
        });
    }
}

export function createLogger(subject: string | InstanceType<ClassType>, defaultData?: LogData) {
    const name = typeof subject === 'string' ? subject : subject.constructor.name;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return r<ExtendedLogger>(Logger as any).scoped(name, defaultData);
}

export function withLoggerContext<T>(data: LogData, fn: () => Promise<T>): Promise<T> {
    const existingContext = getContext();
    return withContextData(
        {
            [LoggerContextSymbol]: {
                ...existingContext?.[LoggerContextSymbol],
                ...data
            }
        },
        fn
    );
}

function transformAxiosError(err: AxiosError) {
    return {
        code: err.code,
        message: err.message,
        stack: err.stack,
        request: {
            url: err.config?.url,
            method: err.config?.method,
            headers: err.config?.headers,
            data: err.config?.data
        },
        response: {
            status: err.response?.status,
            headers: err.response?.headers,
            data: err.response?.data
        }
    };
}
