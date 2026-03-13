import type { BaseMessage, ISrpcServerOptions, SrpcDisconnectCause, SrpcMeta, SrpcStream } from '../../srpc/types';
import type { MeshBroadcastMap, MeshBroadcastOptions, MeshServiceOptions } from '../mesh';

import { SrpcServer } from '../../srpc/SrpcServer';
import { createLogger } from '../logger';
import { MeshClientRegistry } from './mesh-client-registry';
import { MeshClientService } from './mesh-client-service';
import { ClientDisconnectedError, type MeshClientRegistryBackend, type RegisteredClient } from './types';

// --- Options ---

export interface MeshSrpcServerOptions<TMeta, TRegistryMeta = TMeta> {
    meshKey: string;
    meshOptions?: MeshServiceOptions;
    registryBackend?: MeshClientRegistryBackend<TRegistryMeta>;
    extractMetadata?: (stream: SrpcStream<TMeta>) => TRegistryMeta;
}

// --- MeshSrpcServer ---

export class MeshSrpcServer<
    TMeta extends SrpcMeta = SrpcMeta,
    TClientOutput extends BaseMessage = BaseMessage,
    TServerOutput extends BaseMessage = BaseMessage,
    TRegistryMeta = TMeta,
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    TBroadcasts extends MeshBroadcastMap = {}
> extends SrpcServer<TMeta, TClientOutput, TServerOutput> {
    private meshClientService: MeshClientService<TRegistryMeta, TBroadcasts>;
    private meshLogger = createLogger(this);
    private extractMetadataFn?: (stream: SrpcStream<TMeta>) => TRegistryMeta;

    private connectedCallbacks = new Set<(clientId: string, metadata: TRegistryMeta) => void | Promise<void>>();
    private disconnectedCallbacks = new Set<(clientId: string, metadata: TRegistryMeta) => void | Promise<void>>();
    private orphanedCallbacks = new Set<(nodeId: number, clients: RegisteredClient<TRegistryMeta>[]) => void | Promise<void>>();

    // Track metadata for disconnect callbacks
    private clientMetadata = new Map<string, TRegistryMeta>();

    // Serialize register/unregister per client to prevent race conditions
    private clientLifecycleChains = new Map<string, Promise<void>>();

    // Microtask-debounced sync tracking
    private pendingSyncs = new Set<string>();

    constructor(options: ISrpcServerOptions<TClientOutput, TServerOutput> & MeshSrpcServerOptions<TMeta, TRegistryMeta>) {
        super(options);

        this.extractMetadataFn = options.extractMetadata;

        // Cast needed: MeshClientServiceOptions doesn't carry TBroadcasts,
        // but the broadcast generic only affects registerBroadcastHandler/broadcast
        // which are type-safe at the call site.
        this.meshClientService = new MeshClientService({
            key: options.meshKey,
            meshOptions: options.meshOptions,
            registryBackend: options.registryBackend,
            clientInvokeFn: async (clientId: string, type: string, data: unknown, timeoutMs?: number): Promise<unknown> => {
                const stream = this.streamsByClientId.get(clientId);
                if (!stream) {
                    throw new ClientDisconnectedError(clientId);
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return super.invoke(stream, type as any, data as any, timeoutMs);
            }
        }) as MeshClientService<TRegistryMeta, TBroadcasts>;

        // Wire up cross-pod duplicate detection: disconnect local stream when
        // the same client connects on a different node.
        this.meshClientService.onClientSuperseded(async clientId => {
            const stream = this.streamsByClientId.get(clientId);
            if (stream) {
                this.meshLogger.info('Disconnecting superseded client', { clientId });
                this.cleanupStream(stream, 'duplicate');
            }
        });

        // Wire up mesh node cleanup callback
        this.meshClientService.onNodeClientsOrphaned(async (nodeId, orphaned) => {
            for (const cb of this.orphanedCallbacks) {
                try {
                    await cb(nodeId, orphaned);
                } catch (err) {
                    this.meshLogger.warn('orphaned callback error', { err, nodeId });
                }
            }
        });
    }

    ////////////////////////////////////////
    // Lifecycle overrides — auto-register/unregister + proxy-driven meta sync

    private extractMeta(stream: SrpcStream<TMeta>): TRegistryMeta {
        return this.extractMetadataFn ? this.extractMetadataFn(stream) : (stream.meta as unknown as TRegistryMeta);
    }

    private static readonly PROXIED = Symbol('proxied');

    /**
     * Install a Proxy on stream.meta that schedules a microtask-debounced
     * sync to Redis whenever any property is mutated.
     *
     * This means handler code, connection handlers, and external code
     * (e.g. FreeSwitch controller) can all mutate stream.meta directly
     * and the mesh registry stays in sync — no manual sync calls needed.
     *
     * **Limitation:** Only top-level property mutations are tracked.
     * Nested mutations (e.g. `stream.meta.user.name = 'Bob'`) do NOT
     * trigger a sync. For nested metadata, either reassign the top-level
     * property (`stream.meta.user = { ...stream.meta.user, name: 'Bob' }`)
     * or call `updateClientMetadata()` explicitly.
     */
    private installMetaProxy(stream: SrpcStream<TMeta>): void {
        // Guard against double-proxy (e.g. meshStart backfill after onStreamConnected)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((stream.meta as any)[MeshSrpcServer.PROXIED]) return;

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const clientId = stream.clientId;

        const proxied = new Proxy(stream.meta as Record<string, unknown>, {
            get(target, prop) {
                if (prop === MeshSrpcServer.PROXIED) return true;
                return target[prop as string];
            },
            set(target, prop, value) {
                target[prop as string] = value;
                self.scheduleSyncStreamMeta(clientId, stream);
                return true;
            },
            deleteProperty(target, prop) {
                delete target[prop as string];
                self.scheduleSyncStreamMeta(clientId, stream);
                return true;
            }
        });

        // Replace meta with proxied version.
        // stream is a plain object, so this is safe despite the readonly type.
        (stream as { meta: TMeta }).meta = proxied as TMeta;
    }

    /**
     * Schedule a microtask-debounced sync for a client.
     * Multiple synchronous mutations are batched into a single sync.
     */
    private scheduleSyncStreamMeta(clientId: string, stream: SrpcStream<TMeta>): void {
        if (this.pendingSyncs.has(clientId)) return;
        this.pendingSyncs.add(clientId);
        queueMicrotask(() => {
            this.pendingSyncs.delete(clientId);
            // Only sync if this stream is still the active one for this client
            if (this.streamsByClientId.get(clientId) === stream) {
                this.syncStreamMeta(stream);
            }
        });
    }

    protected override onStreamConnected(stream: SrpcStream<TMeta>): void {
        // Install proxy before anything can mutate meta
        this.installMetaProxy(stream);

        const metadata = snapshotMetadata(this.extractMeta(stream));
        this.clientMetadata.set(stream.clientId, metadata);

        this.enqueueClientLifecycle(stream.clientId, async () => {
            await this.meshClientService.registerClient(stream.clientId, metadata);
            for (const cb of this.connectedCallbacks) {
                try {
                    await cb(stream.clientId, metadata);
                } catch (err) {
                    this.meshLogger.warn('client connected callback error', { err, clientId: stream.clientId });
                }
            }
        });

        // Run user-registered connection handlers (may mutate stream.meta — proxy catches it)
        super.onStreamConnected(stream);
    }

    protected override onStreamDisconnected(stream: SrpcStream<TMeta>, cause: SrpcDisconnectCause): void {
        super.onStreamDisconnected(stream, cause);

        this.enqueueClientLifecycle(stream.clientId, async () => {
            // If a replacement stream is already connected, this is a stale
            // disconnect (same-node reconnect). Skip unregister and callbacks,
            // and leave clientMetadata intact for the new stream.
            const currentStream = this.streamsByClientId.get(stream.clientId);
            if (currentStream && currentStream !== stream) {
                return;
            }

            const metadata = this.clientMetadata.get(stream.clientId);
            const removed = await this.meshClientService.unregisterClient(stream.clientId);
            if (removed && metadata) {
                for (const cb of this.disconnectedCallbacks) {
                    try {
                        await cb(stream.clientId, metadata);
                    } catch (err) {
                        this.meshLogger.warn('client disconnected callback error', { err, clientId: stream.clientId });
                    }
                }
            }
            this.clientMetadata.delete(stream.clientId);
        });
    }

    ////////////////////////////////////////
    // Meta sync

    /**
     * Sync the current stream.meta to the mesh registry.
     * Called automatically by the meta proxy's microtask debounce.
     * Routed through enqueueClientLifecycle so updates are serialized
     * after initial registration (prevents lost updates if registration
     * hasn't completed yet).
     */
    private syncStreamMeta(stream: SrpcStream<TMeta>): void {
        // Snapshot the current metadata so we compare values, not references.
        // Without this, the default path (no extractMetadataFn) returns the
        // same proxied object stored in clientMetadata, so shallowChanged
        // would always return false.
        const metadata = snapshotMetadata(this.extractMeta(stream));
        const existing = this.clientMetadata.get(stream.clientId);
        if (existing && !shallowChanged(existing, metadata)) return;

        this.clientMetadata.set(stream.clientId, metadata);
        this.enqueueClientLifecycle(stream.clientId, async () => {
            await this.meshClientService.updateClientMetadata(stream.clientId, metadata);
        });
    }

    ////////////////////////////////////////
    // Client lifecycle serialization

    private enqueueClientLifecycle(clientId: string, fn: () => Promise<void>): void {
        const prev = this.clientLifecycleChains.get(clientId) ?? Promise.resolve();
        const safeFn = () =>
            fn().catch(err => {
                this.meshLogger.warn('client lifecycle error', { err, clientId });
            });
        const next = prev.then(safeFn, safeFn).finally(() => {
            // Clean up the chain entry if it's still ours
            if (this.clientLifecycleChains.get(clientId) === next) {
                this.clientLifecycleChains.delete(clientId);
            }
        });
        this.clientLifecycleChains.set(clientId, next);
    }

    ////////////////////////////////////////
    // Public API

    get meshInstanceId(): number {
        return this.meshClientService.instanceId;
    }

    get clientRegistry(): MeshClientRegistry<TRegistryMeta> {
        return this.meshClientService.clientRegistry;
    }

    /**
     * Explicitly update metadata for a client in the registry.
     * Use this for cross-pod updates where you don't have the local stream.
     * For local streams, just mutate stream.meta directly — the proxy auto-syncs.
     */
    async updateClientMetadata(clientId: string, metadata: TRegistryMeta): Promise<boolean> {
        const updated = await this.meshClientService.updateClientMetadata(clientId, metadata);
        if (updated) {
            this.clientMetadata.set(clientId, metadata);
        }
        return updated;
    }

    onClientConnected(handler: (clientId: string, metadata: TRegistryMeta) => void | Promise<void>): void {
        this.connectedCallbacks.add(handler);
    }

    onClientDisconnected(handler: (clientId: string, metadata: TRegistryMeta) => void | Promise<void>): void {
        this.disconnectedCallbacks.add(handler);
    }

    onNodeClientsOrphaned(handler: (nodeId: number, clients: RegisteredClient<TRegistryMeta>[]) => void | Promise<void>): void {
        this.orphanedCallbacks.add(handler);
    }

    registerBroadcastHandler<K extends keyof TBroadcasts & string>(
        type: K,
        handler: (data: TBroadcasts[K], senderInstanceId: number) => void | Promise<void>
    ): void {
        this.meshClientService.registerBroadcastHandler(type, handler);
    }

    async broadcast<K extends keyof TBroadcasts & string>(type: K, data: TBroadcasts[K], options?: MeshBroadcastOptions): Promise<void> {
        return this.meshClientService.broadcast(type, data, options);
    }

    /**
     * Invoke a client method across any node in the mesh.
     * Overloaded: when called with a stream, delegates to SrpcServer.invoke.
     * When called with a clientId string, routes through the mesh.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override invoke(streamOrClientId: SrpcStream<TMeta> | string, prefix: any, data: any, timeoutMs?: number): Promise<any> {
        if (typeof streamOrClientId === 'string') {
            return this.meshClientService.invoke(streamOrClientId, prefix, data, timeoutMs);
        }
        return super.invoke(streamOrClientId, prefix, data, timeoutMs);
    }

    async meshStart(): Promise<void> {
        await this.meshClientService.start();

        // Backfill clients that connected before mesh tracking was running.
        // Route through enqueueClientLifecycle so backfill registrations are
        // serialized with any concurrent disconnect for the same clientId.
        const backfillPromises: Promise<void>[] = [];
        for (const [clientId, stream] of this.streamsByClientId) {
            // Install proxy if not already proxied (streams that connected before meshStart)
            this.installMetaProxy(stream);

            if (!this.clientMetadata.has(clientId)) {
                const metadata = snapshotMetadata(this.extractMeta(stream));
                this.clientMetadata.set(clientId, metadata);
            }
            const metadata = this.clientMetadata.get(clientId)!;
            this.enqueueClientLifecycle(clientId, async () => {
                // Only register if the stream is still active (hasn't disconnected during startup)
                const currentStream = this.streamsByClientId.get(clientId);
                if (currentStream === stream) {
                    await this.meshClientService.registerClient(clientId, metadata);
                }
            });
            const chain = this.clientLifecycleChains.get(clientId);
            if (chain) backfillPromises.push(chain);
        }
        await Promise.all(backfillPromises);
    }

    async meshStop(): Promise<void> {
        await this.meshClientService.stop();
        this.clientMetadata.clear();
    }
}

////////////////////////////////////////
// Helpers

function snapshotMetadata<T>(meta: T): T {
    if (typeof meta !== 'object' || meta === null) return meta;
    return { ...meta };
}

function shallowChanged(a: unknown, b: unknown): boolean {
    if (a === b) return false;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a !== b;
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
        if (aObj[key] !== bObj[key]) return true;
    }
    return false;
}
