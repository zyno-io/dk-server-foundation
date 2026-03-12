import { createLogger } from '../logger';
import { MeshService, type MeshBroadcastMap, type MeshBroadcastOptions, type MeshServiceOptions } from '../mesh';
import { MeshClientRedisRegistry } from './mesh-client-redis-registry';
import { MeshClientRegistry } from './mesh-client-registry';
import { ClientDisconnectedError, ClientInvocationError, ClientNotFoundError, type MeshClientRegistryBackend, type RegisteredClient } from './types';

// --- Internal Mesh Message Types ---

type ForwardRequest = { clientId: string; type: string; data: unknown; timeoutMs?: number };
type ForwardResponse = { data?: unknown; error?: string; errorName?: string };

type ForwardMessages = {
    forward: { request: ForwardRequest; response: ForwardResponse };
};

// --- Options ---

export interface MeshClientServiceOptions<TMeta> {
    key: string;
    meshOptions?: MeshServiceOptions;
    registryBackend?: MeshClientRegistryBackend<TMeta>;
    clientInvokeFn: (clientId: string, type: string, data: unknown, timeoutMs?: number) => Promise<unknown>;
}

// --- MeshClientService ---

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class MeshClientService<TMeta, TBroadcasts extends MeshBroadcastMap = {}> {
    // Exposed for MeshSrpcServer to access internals
    /** @internal */
    readonly mesh: MeshService<ForwardMessages, TBroadcasts>;
    private logger = createLogger(this);
    private registry: MeshClientRegistry<TMeta>;
    private backend: MeshClientRegistryBackend<TMeta>;
    private clientInvokeFn: MeshClientServiceOptions<TMeta>['clientInvokeFn'];
    private nodeCleanedUpCallbacks: ((nodeId: number, orphaned: RegisteredClient<TMeta>[]) => void | Promise<void>)[] = [];

    constructor(options: MeshClientServiceOptions<TMeta>) {
        this.backend = options.registryBackend ?? new MeshClientRedisRegistry<TMeta>(`_mc:${options.key}`);
        this.clientInvokeFn = options.clientInvokeFn;

        this.mesh = new MeshService<ForwardMessages, TBroadcasts>(`_mc:${options.key}`, options.meshOptions);
        this.mesh.registerHandler('forward', async (req: ForwardRequest): Promise<ForwardResponse> => {
            try {
                const result = await this.clientInvokeFn(req.clientId, req.type, req.data, req.timeoutMs);
                return { data: result };
            } catch (err) {
                return {
                    error: err instanceof Error ? err.message : String(err),
                    errorName: err instanceof Error ? err.name : undefined
                };
            }
        });

        this.mesh.setNodeCleanedUpCallback(async (nodeId: number) => {
            const orphaned = await this.backend.cleanupNode(nodeId);
            if (orphaned.length > 0) {
                for (const cb of this.nodeCleanedUpCallbacks) {
                    try {
                        await cb(nodeId, orphaned);
                    } catch (err) {
                        this.logger.warn('node cleanup callback error', { err, nodeId });
                    }
                }
            }
        });

        // Placeholder registry — will be re-created in start() with the real instanceId
        this.registry = new MeshClientRegistry<TMeta>(0, this.backend);
    }

    onNodeClientsOrphaned(cb: (nodeId: number, orphaned: RegisteredClient<TMeta>[]) => void | Promise<void>): void {
        this.nodeCleanedUpCallbacks.push(cb);
    }

    get instanceId(): number {
        return this.mesh.instanceId;
    }

    get clientRegistry(): MeshClientRegistry<TMeta> {
        return this.registry;
    }

    private running = false;

    async start(): Promise<void> {
        await this.mesh.start();
        this.registry = new MeshClientRegistry<TMeta>(this.mesh.instanceId, this.backend);
        this.running = true;
    }

    async stop(): Promise<void> {
        this.running = false;
        try {
            // Clean up our own clients
            if (this.mesh.instanceId !== 0) {
                await this.registry.cleanupNode();
            }
        } finally {
            await this.mesh.stop();
        }
    }

    async registerClient(clientId: string, metadata: TMeta): Promise<void> {
        if (!this.running) return;
        await this.registry.register(clientId, metadata);
    }

    async unregisterClient(clientId: string): Promise<boolean> {
        if (!this.running) return false;
        return this.registry.unregister(clientId);
    }

    registerBroadcastHandler<K extends keyof TBroadcasts & string>(
        type: K,
        handler: (data: TBroadcasts[K], senderInstanceId: number) => void | Promise<void>
    ): void {
        this.mesh.registerBroadcastHandler(type, handler);
    }

    async broadcast<K extends keyof TBroadcasts & string>(type: K, data: TBroadcasts[K], options?: MeshBroadcastOptions): Promise<void> {
        return this.mesh.broadcast(type, data, options);
    }

    async invoke(clientId: string, type: string, data: unknown, timeoutMs?: number): Promise<unknown> {
        if (!this.running) {
            throw new ClientNotFoundError(clientId);
        }

        const client = await this.registry.getClient(clientId);
        if (!client) {
            throw new ClientNotFoundError(clientId);
        }

        // Local delivery
        if (client.nodeId === this.mesh.instanceId) {
            return this.clientInvokeFn(clientId, type, data, timeoutMs);
        }

        // Remote delivery via mesh
        const response = await this.mesh.invoke(client.nodeId, 'forward', { clientId, type, data, timeoutMs }, timeoutMs);

        if (response.error !== undefined) {
            if (response.errorName === 'ClientDisconnectedError') {
                throw new ClientDisconnectedError(clientId);
            }
            throw new ClientInvocationError(response.error);
        }

        return response.data;
    }
}
