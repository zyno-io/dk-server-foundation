import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, LoggerLevel } from '@deepkit/logger';
import debug from 'debug';

import { BaseAppConfig, createApp, createLogger, DecoratedError, ExtendedLogger, pinoLogger, setGlobalErrorReporter } from '../../src';

describe('logger', () => {
    describe('injection', () => {
        it('should allow injecting ExtendedLogger directly via constructor', () => {
            class TestService {
                constructor(public logger: ExtendedLogger) {}
            }

            const app = createApp({
                config: BaseAppConfig,
                providers: [TestService]
            });

            const service = app.get(TestService);
            assert.ok(service.logger instanceof ExtendedLogger);
        });

        it('should inject ExtendedLogger when requesting Logger', () => {
            class TestService {
                constructor(public logger: Logger) {}
            }

            const app = createApp({
                config: BaseAppConfig,
                providers: [TestService]
            });

            const service = app.get(TestService);
            assert.ok(service.logger instanceof ExtendedLogger);
        });
    });
    let logger: ExtendedLogger;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alertSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let errorSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let warningSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let noticeSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let infoSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let debugSpy: any;

    const errMessage = 'test logger error message';
    const err = new Error(errMessage);

    const fn = mock.fn();
    const checkFn = (level: LoggerLevel, expectCause = true) => {
        assert.strictEqual(fn.mock.callCount(), 1);
        const args = fn.mock.calls[0].arguments;
        assert.strictEqual(args[0], level);
        assert.ok(args[1] instanceof Error);
        assert.ok(typeof args[2] === 'object' && args[2] !== null);

        const reportedError: DecoratedError = args[1];
        assert.strictEqual(reportedError.message, 'something failed');

        if (expectCause) {
            assert.ok(reportedError.cause instanceof Error);
            assert.strictEqual(reportedError.cause?.message, errMessage);
        } else {
            assert.strictEqual(reportedError.cause, undefined);
        }

        fn.mock.resetCalls();
    };

    before(() => {
        const app = createApp({ config: BaseAppConfig });
        logger = app.get(ExtendedLogger);

        alertSpy = mock.method(pinoLogger, 'ALERT', () => {});
        infoSpy = mock.method(pinoLogger, 'INFO', () => {});
        warningSpy = mock.method(pinoLogger, 'WARNING', () => {});
        noticeSpy = mock.method(pinoLogger, 'NOTICE', () => {});
        errorSpy = mock.method(pinoLogger, 'ERROR', () => {});
        debugSpy = mock.method(pinoLogger, 'DEBUG', () => {});

        setGlobalErrorReporter(fn);
    });

    afterEach(() => {
        alertSpy.mock.resetCalls();
        errorSpy.mock.resetCalls();
        warningSpy.mock.resetCalls();
        noticeSpy.mock.resetCalls();
        infoSpy.mock.resetCalls();
        debugSpy.mock.resetCalls();
        fn.mock.resetCalls();
    });
    after(() => {
        mock.restoreAll();
    });

    it('should log messages using the correct pino channels', () => {
        logger.alert('hello alert');
        logger.error('hello error');
        logger.warn('hello warning');
        logger.log('hello log');
        logger.info('hello info');
        logger.debug('hello debug');

        assert.strictEqual(alertSpy.mock.callCount(), 1);
        assert.deepStrictEqual(alertSpy.mock.calls[0].arguments, [{}, 'hello alert']);

        assert.strictEqual(errorSpy.mock.callCount(), 1);
        assert.deepStrictEqual(errorSpy.mock.calls[0].arguments, [{}, 'hello error']);

        assert.strictEqual(warningSpy.mock.callCount(), 1);
        assert.deepStrictEqual(warningSpy.mock.calls[0].arguments, [{}, 'hello warning']);

        assert.strictEqual(noticeSpy.mock.callCount(), 1);
        assert.deepStrictEqual(noticeSpy.mock.calls[0].arguments, [{}, 'hello log']);

        assert.strictEqual(infoSpy.mock.callCount(), 1);
        assert.deepStrictEqual(infoSpy.mock.calls[0].arguments, [{}, 'hello info']);

        assert.strictEqual(debugSpy.mock.callCount(), 0);
    });

    it('should correctly log debug messages when debug is enabled for scope', () => {
        debug.enable('testScope');
        logger.scoped('testScope').debug('debug message');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'testScope' }, 'debug message']);
    });

    it('should include scope data in log messages', () => {
        debug.enable('scopeWithData');
        logger.scoped('scopeWithData', { requestId: '123', userId: 'abc' }).debug('message with data');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'scopeWithData', requestId: '123', userId: 'abc' }, 'message with data']);
    });

    it('should inherit parent scope data in nested scopes', () => {
        debug.enable('parent:child');
        const parentLogger = logger.scoped('parent', { parentKey: 'parentValue' });
        const childLogger = parentLogger.scoped('child', { childKey: 'childValue' });
        childLogger.debug('nested message');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [
            { scope: 'parent:child', parentKey: 'parentValue', childKey: 'childValue' },
            'nested message'
        ]);
    });

    it('should allow child scope data to override parent scope data', () => {
        debug.enable('outer:inner');
        const outerLogger = logger.scoped('outer', { shared: 'outer', outerOnly: 'value' });
        const innerLogger = outerLogger.scoped('inner', { shared: 'inner', innerOnly: 'value' });
        innerLogger.debug('override message');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [
            { scope: 'outer:inner', shared: 'inner', outerOnly: 'value', innerOnly: 'value' },
            'override message'
        ]);
    });

    it('should return the same cached instance when scoped() is called without data', () => {
        const scoped1 = logger.scoped('cachedScope');
        const scoped2 = logger.scoped('cachedScope');
        assert.strictEqual(scoped1, scoped2);
    });

    it('should return different instances when scoped() is called with data', () => {
        debug.enable('isolatedScope');
        const scoped1 = logger.scoped('isolatedScope', { callId: 'call-1' });
        const scoped2 = logger.scoped('isolatedScope', { callId: 'call-2' });

        // Should be different instances to avoid sharing scopeData
        assert.notStrictEqual(scoped1, scoped2);

        // Each instance should have its own data
        scoped1.debug('message from call 1');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'isolatedScope', callId: 'call-1' }, 'message from call 1']);

        debugSpy.mock.resetCalls();
        scoped2.debug('message from call 2');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'isolatedScope', callId: 'call-2' }, 'message from call 2']);
    });

    it('should not mutate cached scope when scoped() is called with data', () => {
        debug.enable('mixedScope');

        // First get a cached scope without data
        const cachedScope = logger.scoped('mixedScope');

        // Then create a new scope with data (should not affect the cached one)
        const scopedWithData = logger.scoped('mixedScope', { sessionId: 'session-123' });

        // The cached scope should still work without the extra data
        cachedScope.debug('cached message');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'mixedScope' }, 'cached message']);

        debugSpy.mock.resetCalls();

        // The scoped with data should have its own data
        scopedWithData.debug('message with session');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'mixedScope', sessionId: 'session-123' }, 'message with session']);
    });

    it('should return independent loggers when createLogger is called with same name but different data', () => {
        debug.enable('SipClient');
        const logger1 = createLogger('SipClient', { extensionId: 'ext-100' });
        const logger2 = createLogger('SipClient', { extensionId: 'ext-200' });

        // Should be different instances
        assert.notStrictEqual(logger1, logger2);

        // Each should log with its own extensionId
        logger1.debug('message from ext-100');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'SipClient', extensionId: 'ext-100' }, 'message from ext-100']);

        debugSpy.mock.resetCalls();

        logger2.debug('message from ext-200');
        assert.strictEqual(debugSpy.mock.callCount(), 1);
        assert.deepStrictEqual(debugSpy.mock.calls[0].arguments, [{ scope: 'SipClient', extensionId: 'ext-200' }, 'message from ext-200']);
    });

    it('should correctly handle errors passed as the only argument', () => {
        logger.error(new Error('something failed'));
        assert.strictEqual(errorSpy.mock.callCount(), 1);
        assert.ok(errorSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(errorSpy.mock.calls[0].arguments[1], '');
        checkFn(LoggerLevel.error, false);

        logger.warn(new Error('something failed'));
        assert.strictEqual(warningSpy.mock.callCount(), 1);
        assert.ok(warningSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(warningSpy.mock.calls[0].arguments[1], '');
        checkFn(LoggerLevel.warning, false);
    });

    it('should correctly handle errors passed as the first argument', () => {
        logger.error(err, 'something failed');
        assert.strictEqual(errorSpy.mock.callCount(), 1);
        assert.ok(errorSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(errorSpy.mock.calls[0].arguments[1], 'something failed');
        checkFn(LoggerLevel.error);

        logger.warn(err, 'something failed');
        assert.strictEqual(warningSpy.mock.callCount(), 1);
        assert.ok(warningSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(warningSpy.mock.calls[0].arguments[1], 'something failed');
        checkFn(LoggerLevel.warning);
    });

    it('should correctly handle errors passed as the second argument', () => {
        logger.error('something failed', err);
        assert.strictEqual(errorSpy.mock.callCount(), 1);
        assert.ok(errorSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(errorSpy.mock.calls[0].arguments[1], 'something failed');
        checkFn(LoggerLevel.error);

        logger.warn('something failed', err);
        assert.strictEqual(warningSpy.mock.callCount(), 1);
        assert.ok(warningSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(warningSpy.mock.calls[0].arguments[1], 'something failed');
        checkFn(LoggerLevel.warning);
    });

    it('should correctly handle errors passed in an object in the second argument', () => {
        logger.error('something failed', { err });
        assert.strictEqual(errorSpy.mock.callCount(), 1);
        assert.ok(errorSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(errorSpy.mock.calls[0].arguments[1], 'something failed');
        checkFn(LoggerLevel.error);

        logger.warn('something failed', { err });
        assert.strictEqual(warningSpy.mock.callCount(), 1);
        assert.ok(warningSpy.mock.calls[0].arguments[0].err instanceof Error);
        assert.strictEqual(warningSpy.mock.calls[0].arguments[1], 'something failed');
        checkFn(LoggerLevel.warning);
    });
});
