import type { BaseMessage, ISrpcServerOptions, SrpcMeta, SrpcStream } from '../../srpc/types';
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

        // Auto-register on connect
        this.registerConnectionHandler((stream: SrpcStream<TMeta>) => {
            const metadata = this.extractMetadataFn ? this.extractMetadataFn(stream) : (stream.meta as unknown as TRegistryMeta);
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
        });

        // Auto-unregister on disconnect
        this.registerDisconnectHandler((stream: SrpcStream<TMeta>) => {
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
        });
    }

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

    get meshInstanceId(): number {
        return this.meshClientService.instanceId;
    }

    get clientRegistry(): MeshClientRegistry<TRegistryMeta> {
        return this.meshClientService.clientRegistry;
    }

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
            if (!this.clientMetadata.has(clientId)) {
                const metadata = this.extractMetadataFn ? this.extractMetadataFn(stream) : (stream.meta as unknown as TRegistryMeta);
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
