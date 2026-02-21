// https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/plugins/node/opentelemetry-instrumentation-mysql/src/instrumentation.ts

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Attributes, MeterProvider, UpDownCounter } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from '@opentelemetry/instrumentation';
import { AttributeNames } from '@opentelemetry/instrumentation-mysql/build/src/AttributeNames';
import { MySQLInstrumentationConfig } from '@opentelemetry/instrumentation-mysql/build/src/types';
import { getDbQueryText, getDbValues, getSpanName } from '@opentelemetry/instrumentation-mysql/build/src/utils';
import { ATTR_DB_QUERY_TEXT, ATTR_DB_SYSTEM_NAME, DB_SYSTEM_NAME_VALUE_MARIADB } from '@opentelemetry/semantic-conventions';
import type * as mariadbTypes from 'mariadb';

import { withSpan } from './helpers';

export class MariaDBInstrumentation extends InstrumentationBase {
    static readonly COMMON_ATTRIBUTES = {
        [ATTR_DB_SYSTEM_NAME]: DB_SYSTEM_NAME_VALUE_MARIADB
    };
    private _connectionsUsage!: UpDownCounter;

    constructor(config?: MySQLInstrumentationConfig) {
        super('@opentelemetry/instrumentation-mariadb', '0.0.1', config ?? {});
        this._setMetricInstruments();
    }

    override setMeterProvider(meterProvider: MeterProvider) {
        super.setMeterProvider(meterProvider);
        this._setMetricInstruments();
    }

    private _setMetricInstruments() {
        this._connectionsUsage = this.meter.createUpDownCounter(
            'db.client.connections.usage', //TODO:: use semantic convention
            {
                description: 'The number of connections that are currently in state described by the state attribute.',
                unit: '{connection}'
            }
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private _originals = new Map<string, Function>();

    // mariadb 3.5+ uses ESM, where exports are writable but not configurable.
    // shimmer's _wrap uses Object.defineProperty which requires configurable,
    // so we fall back to direct assignment for non-configurable properties.
    private _wrapCompat<K extends keyof typeof mariadbTypes>(
        moduleExports: typeof mariadbTypes,
        name: K,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        wrapper: (original: Function) => Function
    ) {
        const descriptor = Object.getOwnPropertyDescriptor(moduleExports, name);
        // oxlint-disable-next-line typescript/no-unsafe-function-type
        const original = moduleExports[name] as Function;
        if (descriptor && !descriptor.configurable) {
            this._originals.set(name, original);
            // oxlint-disable-next-line typescript/no-explicit-any
            (moduleExports as any)[name] = wrapper(original);
        } else {
            // oxlint-disable-next-line typescript/no-explicit-any
            this._wrap(moduleExports, name, wrapper as any);
        }
    }

    private _unwrapCompat<K extends keyof typeof mariadbTypes>(moduleExports: typeof mariadbTypes, name: K) {
        const original = this._originals.get(name);
        if (original) {
            // oxlint-disable-next-line typescript/no-explicit-any
            (moduleExports as any)[name] = original;
            this._originals.delete(name);
        } else {
            this._unwrap(moduleExports, name);
        }
    }

    protected init() {
        return [
            new InstrumentationNodeModuleDefinition(
                'mariadb',
                ['3.*'],
                moduleExports => {
                    // ESM namespace objects are sealed (non-configurable, non-writable).
                    // Create a mutable shallow copy so we can patch the exports.
                    if (!Object.isExtensible(moduleExports)) {
                        moduleExports = { ...moduleExports };
                    }

                    if (isWrapped(moduleExports.createConnection)) {
                        this._unwrapCompat(moduleExports, 'createConnection');
                    }
                    this._wrapCompat(moduleExports, 'createConnection', this._patchCreateConnection());

                    if (isWrapped(moduleExports.createPool)) {
                        this._unwrapCompat(moduleExports, 'createPool');
                    }
                    this._wrapCompat(moduleExports, 'createPool', this._patchCreatePool());

                    if (isWrapped(moduleExports.createPoolCluster)) {
                        this._unwrapCompat(moduleExports, 'createPoolCluster');
                    }
                    this._wrapCompat(moduleExports, 'createPoolCluster', this._patchCreatePoolCluster());

                    return moduleExports;
                },
                moduleExports => {
                    if (moduleExports === undefined) return;
                    this._unwrapCompat(moduleExports, 'createConnection');
                    this._unwrapCompat(moduleExports, 'createPool');
                    this._unwrapCompat(moduleExports, 'createPoolCluster');
                }
            )
        ];
    }

    // global export function
    private _patchCreateConnection() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalCreateConnection: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;

            return function createConnection(_connectionUri: string | mariadbTypes.ConnectionConfig) {
                // eslint-disable-next-line prefer-rest-params
                const originalResult = originalCreateConnection(...arguments);

                // This is unwrapped on next call after unpatch
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                thisPlugin._wrap(originalResult, 'query', thisPlugin._patchQuery(originalResult) as any);

                return originalResult;
            };
        };
    }

    // global export function
    private _patchCreatePool() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalCreatePool: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;
            return function createPool(_config: string | mariadbTypes.PoolConfig) {
                // eslint-disable-next-line prefer-rest-params
                const pool = originalCreatePool(...arguments);

                thisPlugin._wrap(pool, 'query', thisPlugin._patchQuery(pool));
                thisPlugin._wrap(pool, 'getConnection', thisPlugin._patchGetConnection(pool));
                thisPlugin._wrap(pool, 'end', thisPlugin._patchPoolEnd(pool));
                thisPlugin._setPoolcallbacks(pool, thisPlugin, '');

                return pool;
            };
        };
    }
    private _patchPoolEnd(pool: mariadbTypes.Pool) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalPoolEnd: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;
            return function end(_callback?: unknown) {
                const nAll = pool.totalConnections();
                const nFree = pool.idleConnections();
                const nUsed = nAll - nFree;
                const poolName = 'unk'; // todo
                thisPlugin._connectionsUsage.add(-nUsed, {
                    state: 'used',
                    name: poolName
                });
                thisPlugin._connectionsUsage.add(-nFree, {
                    state: 'idle',
                    name: poolName
                });
                // eslint-disable-next-line prefer-rest-params
                return originalPoolEnd.apply(pool, arguments);
            };
        };
    }

    // global export function
    private _patchCreatePoolCluster() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalCreatePoolCluster: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;
            return function createPool(_config: string | mariadbTypes.PoolConfig) {
                // eslint-disable-next-line prefer-rest-params
                const cluster = originalCreatePoolCluster(...arguments);

                // This is unwrapped on next call after unpatch
                thisPlugin._wrap(cluster, 'getConnection', thisPlugin._patchGetConnection(cluster));
                thisPlugin._wrap(cluster, 'add', thisPlugin._patchAdd(cluster));

                return cluster;
            };
        };
    }
    private _patchAdd(cluster: mariadbTypes.PoolCluster) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalAdd: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;
            return function add(id: string, _config: unknown) {
                // Unwrap if unpatch has been called
                if (!thisPlugin['_enabled']) {
                    thisPlugin._unwrap(cluster, 'add');
                    // eslint-disable-next-line prefer-rest-params
                    return originalAdd.apply(cluster, arguments);
                }
                // eslint-disable-next-line prefer-rest-params
                originalAdd.apply(cluster, arguments);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const nodes = cluster['_nodes' as keyof mariadbTypes.PoolCluster] as any;
                if (nodes) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const nodeId = typeof id === 'object' ? 'CLUSTER::' + (cluster as any)._lastId : String(id);

                    const pool = nodes[nodeId].pool;
                    thisPlugin._setPoolcallbacks(pool, thisPlugin, id);
                }
            };
        };
    }

    // method on cluster or pool
    private _patchGetConnection(pool: mariadbTypes.Pool | mariadbTypes.PoolCluster) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalGetConnection: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;
            return async function getConnection() {
                // Unwrap if unpatch has been called
                if (!thisPlugin['_enabled']) {
                    thisPlugin._unwrap(pool, 'getConnection');
                    // eslint-disable-next-line prefer-rest-params
                    return originalGetConnection.apply(pool, arguments);
                }

                // eslint-disable-next-line prefer-rest-params
                const connection = await originalGetConnection.apply(pool, arguments);
                if (!isWrapped(connection.query)) {
                    thisPlugin._wrap(connection, 'query', thisPlugin._patchQuery(connection));
                }

                return connection;
            };
        };
    }

    private _patchQuery(connection: mariadbTypes.Connection | mariadbTypes.Pool) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        return (originalQuery: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const thisPlugin = this;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return function query(query: string, _valuesOrCallback?: any[]) {
                if (!thisPlugin['_enabled']) {
                    thisPlugin._unwrap(connection, 'query');
                    // eslint-disable-next-line prefer-rest-params
                    return originalQuery.apply(connection, arguments);
                }

                query = query.trim();

                const spanName = getSpanName(query);
                const spanAttributes: Attributes = {
                    ...MariaDBInstrumentation.COMMON_ATTRIBUTES,
                    [ATTR_DB_QUERY_TEXT]: getDbQueryText(query)
                };

                const instrumentationConfig: MySQLInstrumentationConfig = thisPlugin.getConfig();
                if (instrumentationConfig.enhancedDatabaseReporting) {
                    let values;

                    if (Array.isArray(_valuesOrCallback)) {
                        values = _valuesOrCallback;
                        // eslint-disable-next-line prefer-rest-params
                    } else if (arguments[2]) {
                        values = [_valuesOrCallback];
                    }

                    spanAttributes[AttributeNames.MYSQL_VALUES] = getDbValues(query, values);
                }

                return withSpan(spanName, spanAttributes, () => originalQuery.apply(connection, [query, _valuesOrCallback]));
            };
        };
    }

    private _setPoolcallbacks(pool: mariadbTypes.Pool, thisPlugin: MariaDBInstrumentation, id: string) {
        //TODO:: use semantic convention
        const poolName = id || 'unk';

        pool.on('connection', _connection => {
            thisPlugin._connectionsUsage.add(1, {
                state: 'idle',
                name: poolName
            });
        });

        pool.on('acquire', _connection => {
            thisPlugin._connectionsUsage.add(-1, {
                state: 'idle',
                name: poolName
            });
            thisPlugin._connectionsUsage.add(1, {
                state: 'used',
                name: poolName
            });
        });

        pool.on('release', _connection => {
            thisPlugin._connectionsUsage.add(-1, {
                state: 'used',
                name: poolName
            });
            thisPlugin._connectionsUsage.add(1, {
                state: 'idle',
                name: poolName
            });
        });
    }
}
