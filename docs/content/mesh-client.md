# Mesh Client Tracking

Track clients connected across multiple backend nodes and invoke operations on any client regardless of which node it's connected to. Built on top of [MeshService](./mesh-service.md).

Three layers, each building on the previous:

1. **MeshClientRegistry** — tracks which clients are connected where, with metadata
2. **MeshClientService** — adds transparent cross-node client invocation
3. **MeshSrpcServer** — extends SrpcServer with auto-registration, lifecycle callbacks, and distributed invoke

## MeshClientRegistry

Track which clients are connected to which node, with arbitrary metadata.

```typescript
import { MeshClientRegistry, MeshClientRedisRegistry } from '@zyno-io/dk-server-foundation';

interface ClientMeta {
    userId: string;
    role: string;
}

// Usually you don't construct this manually — MeshClientService and MeshSrpcServer create it for you.
// But if you need standalone tracking:
const backend = new MeshClientRedisRegistry<ClientMeta>('my-app');
const registry = new MeshClientRegistry<ClientMeta>(mesh.instanceId, backend);

await registry.register('client-123', { userId: 'user-1', role: 'admin' });

const client = await registry.getClient('client-123');
// { clientId: 'client-123', nodeId: 1, metadata: { userId: 'user-1', role: 'admin' } }

const all = await registry.listClients();
const local = await registry.listClientsForNode(mesh.instanceId);

// Update metadata (ownership-safe: only updates if this node owns the registration)
const updated = await registry.updateMetadata('client-123', { userId: 'user-1', role: 'superadmin' });

// Ownership-safe: only removes if this node owns the registration
const removed = await registry.unregister('client-123'); // true if removed, false if client moved
```

The `MeshClientRegistryBackend` interface is pluggable — implement your own for database-backed tracking:

```typescript
class DatabaseClientRegistry<TMeta> implements MeshClientRegistryBackend<TMeta> {
    async register(clientId: string, nodeId: number, metadata: TMeta): Promise<void> {
        await db.query(`INSERT INTO connected_clients ... ON DUPLICATE KEY UPDATE ...`);
    }
    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        const result = await db.query(`DELETE FROM connected_clients WHERE client_id = ? AND node_id = ?`, [clientId, nodeId]);
        return result.affectedRows > 0;
    }
    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const result = await db.query(`UPDATE connected_clients SET metadata = ? WHERE client_id = ? AND node_id = ?`, [
            JSON.stringify(metadata),
            clientId,
            nodeId
        ]);
        return result.affectedRows > 0;
    }
    async getClient(clientId: string) {
        /* ... */
    }
    async listClients() {
        /* ... */
    }
    async listClientsForNode(nodeId: number) {
        /* ... */
    }
    async cleanupNode(nodeId: number) {
        /* ... */
    }
}
```

### API

#### `new MeshClientRegistry<TMeta>(nodeId: number, backend: MeshClientRegistryBackend<TMeta>)`

Creates a registry bound to a specific mesh node ID.

#### `register(clientId, metadata)` → `Promise<void>`

Register a client on this node. If the client was previously registered on a different node, the old registration is atomically replaced.

#### `unregister(clientId)` → `Promise<boolean>`

Remove a client registration. Returns `true` if the client was owned by this node and was removed. Returns `false` if the client had already reconnected to a different node (ownership-safe).

#### `updateMetadata(clientId, metadata)` → `Promise<boolean>`

Update metadata for a registered client. Returns `true` if the client was owned by this node and was updated. Returns `false` if the client is not registered or has moved to a different node (ownership-safe).

#### `getClient(clientId)` → `Promise<RegisteredClient<TMeta> | undefined>`

Look up a client by ID across all nodes.

#### `listClients()` → `Promise<RegisteredClient<TMeta>[]>`

List all registered clients across all nodes.

#### `listClientsForNode(nodeId?)` → `Promise<RegisteredClient<TMeta>[]>`

List clients for a specific node. Defaults to this registry's node.

#### `cleanupNode(nodeId?)` → `Promise<RegisteredClient<TMeta>[]>`

Remove all clients for a node, returning the orphaned clients (with metadata). Only removes clients still owned by that node — clients that reconnected elsewhere are left intact.

---

## MeshClientService

Combines MeshClientRegistry with MeshService for transparent cross-node client invocation. You provide a `clientInvokeFn` — called when another node invokes something for a client connected to your node.

```typescript
import { MeshClientService } from '@zyno-io/dk-server-foundation';

// Define broadcast types for type-safe broadcasting
interface MyBroadcasts {
    configUpdated: { keys: string[] };
}

const clientService = new MeshClientService<ClientMeta, MyBroadcasts>({
    key: 'my-app',
    clientInvokeFn: async (clientId, type, data, timeoutMs) => {
        // Another node wants to invoke something on a client connected to THIS node.
        // Deliver the message however you want.
        return localDelivery(clientId, type, data);
    }
});

await clientService.start();

await clientService.registerClient('client-123', { userId: 'user-1', role: 'admin' });

// Update metadata after registration (ownership-safe)
await clientService.updateClientMetadata('client-123', { userId: 'user-1', role: 'superadmin' });

// Invoke on any client — routes through mesh if on a different node
const result = await clientService.invoke('client-123', 'notify', { text: 'hello' });

// Broadcast to all nodes
clientService.registerBroadcastHandler('configUpdated', (data, senderInstanceId) => {
    console.log(`Config updated by node ${senderInstanceId}:`, data.keys);
});
await clientService.broadcast('configUpdated', { keys: ['feature-flag-x'] });

const clients = await clientService.clientRegistry.listClients();

await clientService.stop();
```

### API

#### `new MeshClientService<TMeta, TBroadcasts>(options)`

| Option            | Type                                                     | Description                                                     |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `key`             | `string`                                                 | Mesh key (internally namespaced as `_mc:{key}`)                 |
| `meshOptions`     | `MeshServiceOptions`                                     | Optional tuning for the internal mesh node                      |
| `registryBackend` | `MeshClientRegistryBackend`                              | Optional custom backend (defaults to `MeshClientRedisRegistry`) |
| `clientInvokeFn`  | `(clientId, type, data, timeoutMs?) => Promise<unknown>` | Called when a client invoke arrives for this node               |

#### Properties

| Property         | Type                        | Description                   |
| ---------------- | --------------------------- | ----------------------------- |
| `instanceId`     | `number`                    | This node's mesh instance ID  |
| `clientRegistry` | `MeshClientRegistry<TMeta>` | Direct access to the registry |

#### Methods

| Method                                                          | Description                                          |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `start()`                                                       | Start the internal mesh and initialize the registry  |
| `stop()`                                                        | Clean up own clients, stop the mesh                  |
| `registerClient(clientId, metadata)`                            | Register a client on this node                       |
| `unregisterClient(clientId)` → `Promise<boolean>`               | Unregister (returns false if client moved elsewhere) |
| `updateClientMetadata(clientId, metadata)` → `Promise<boolean>` | Update metadata (returns false if client moved)      |
| `invoke(clientId, type, data, timeoutMs?)`                      | Invoke on any client, routes automatically           |
| `registerBroadcastHandler(type, handler)`                       | Register a handler for a broadcast type              |
| `broadcast(type, data, options?)`                               | Broadcast to all nodes in the mesh                   |

---

## MeshSrpcServer

Extends `SrpcServer` with mesh client tracking. Single class — no need to create an SrpcServer separately.

```typescript
import { MeshSrpcServer } from '@zyno-io/dk-server-foundation';
import { ClientMessage, ServerMessage } from './generated/proto';

const server = new MeshSrpcServer({
    // SrpcServer options
    logger,
    clientMessage: ClientMessage,
    serverMessage: ServerMessage,
    wsPath: '/srpc',

    // Mesh options
    meshKey: 'my-app'
});

// Register SRPC handlers as usual
server.registerMessageHandler('uEcho', async (stream, data) => {
    return { message: `Echo: ${data.message}` };
});

// Lifecycle callbacks
server.onClientConnected((clientId, metadata) => {
    console.log(`Client ${clientId} connected`);
    db.updatePresence(clientId, 'online');
});

server.onClientDisconnected((clientId, metadata) => {
    // Only fires if the client actually left — NOT if it reconnected to another node
    console.log(`Client ${clientId} disconnected`);
    db.updatePresence(clientId, 'offline');
});

server.onNodeClientsOrphaned((nodeId, clients) => {
    // Fires on the leader when a dead node is cleaned up
    // Only includes clients that didn't reconnect elsewhere
    console.log(`Node ${nodeId} died, ${clients.length} orphaned clients`);
    for (const client of clients) {
        db.updatePresence(client.clientId, 'offline');
    }
});

await server.meshStart();

// Update client metadata at any time (ownership-safe)
await server.updateClientMetadata('client-123', { ...metadata, role: 'superadmin' });

// Type-safe invoke on any client, regardless of which node
await server.invoke('client-123', 'dNotify', { text: 'hello' });

// Broadcast to all nodes (uses MeshService broadcast under the hood)
// Add a TBroadcasts generic to the server for type-safe broadcasts:
//   new MeshSrpcServer<Meta, ClientMsg, ServerMsg, RegistryMeta, MyBroadcasts>(...)
server.registerBroadcastHandler('configUpdated', (data, senderInstanceId) => {
    console.log(`Config updated by node ${senderInstanceId}:`, data);
});
await server.broadcast('configUpdated', { keys: ['feature-flag-x'] });

// Access the registry
const allClients = await server.clientRegistry.listClients();

// Shutdown
await server.meshStop();
server.close();
```

### API

#### Constructor

```typescript
new MeshSrpcServer(options: ISrpcServerOptions & MeshSrpcServerOptions)
```

`MeshSrpcServerOptions`:

| Option            | Type                        | Description                                    |
| ----------------- | --------------------------- | ---------------------------------------------- |
| `meshKey`         | `string`                    | Mesh key                                       |
| `meshOptions`     | `MeshServiceOptions`        | Optional mesh tuning                           |
| `registryBackend` | `MeshClientRegistryBackend` | Optional custom backend                        |
| `extractMetadata` | `(stream) => TRegistryMeta` | Optional metadata extraction from SRPC streams |

#### Properties

| Property         | Type                        | Description                   |
| ---------------- | --------------------------- | ----------------------------- |
| `meshInstanceId` | `number`                    | This node's mesh instance ID  |
| `clientRegistry` | `MeshClientRegistry<TMeta>` | Direct access to the registry |

#### Methods

| Method                                       | Description                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `meshStart()`                                | Start mesh client tracking                                                                |
| `meshStop()`                                 | Stop mesh client tracking (call before `close()`)                                         |
| `updateClientMetadata(clientId, metadata)`   | Update metadata (returns false if client moved); also updates local cache                 |
| `invoke(clientId, prefix, data, timeoutMs?)` | Type-safe invoke on any client across any node                                            |
| `registerBroadcastHandler(type, handler)`    | Register a handler for a broadcast type (see [MeshService broadcasts](./mesh-service.md)) |
| `broadcast(type, data, options?)`            | Broadcast to all nodes in the mesh                                                        |
| `onClientConnected(handler)`                 | Fires on the node the client connected to                                                 |
| `onClientDisconnected(handler)`              | Fires on the node the client disconnected from                                            |
| `onNodeClientsOrphaned(handler)`             | Fires on the **leader node** when a dead node's clients are cleaned up                    |

Plus all `SrpcServer` methods: `registerMessageHandler`, `registerConnectionHandler`, `registerDisconnectHandler`, `setClientAuthorizer`, etc.

---

## Error Classes

| Error                     | When                                                                  |
| ------------------------- | --------------------------------------------------------------------- |
| `ClientNotFoundError`     | `invoke()` called with a clientId not in the registry                 |
| `ClientDisconnectedError` | Client was in the registry but no longer connected on the target node |
| `ClientInvocationError`   | Remote delivery failed (wraps the original error message)             |
| `MeshRequestTimeoutError` | The remote node didn't respond to the mesh forwarding request         |
