import { http, HttpQueries, HttpRequest, HttpResponse } from '@deepkit/http';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TestingHelpers } from '../../src';
import { BaseAppConfig } from '../../src/app';
import { assertMatchObject } from '../shared/helpers';

describe('App', () => {
    it('test a basic app', async () => {
        class AppConfig extends BaseAppConfig {
            TEST_CONFIG_ITEM = 'testValue';
        }

        class TestProvider {
            constructor(private config: AppConfig) {}

            getItem() {
                return this.config.TEST_CONFIG_ITEM;
            }
        }

        @http.controller('/test')
        class TestController {
            constructor(private testProvider: TestProvider) {}

            @http.GET()
            get(input: HttpQueries<{ a: string }>, response: HttpResponse) {
                response.statusCode = 202;
                return {
                    a: input.a,
                    c: this.testProvider.getItem()
                };
            }
        }

        const app = TestingHelpers.createTestingFacade({
            config: AppConfig,
            controllers: [TestController],
            providers: [TestProvider]
        });

        try {
            await app.start();

            const response = await app.request(HttpRequest.GET('/test?a=bananas'));
            assert.strictEqual(response.statusCode, 202);
            assertMatchObject(response.json, { a: 'bananas', c: 'testValue' });
        } finally {
            await app.stop();
        }
    });
});
