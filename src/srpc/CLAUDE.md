# SRPC (Simple RPC)

`src/srpc/` implements a bidirectional RPC layer on top of WebSocket with authentication, tracing, and byte-stream support.

## Proto Naming Convention

SRPC uses a clear naming convention for protobuf messages:

- **Container messages**: `ClientMessage` (what the client sends) and `ServerMessage` (what the server sends)
- **Upstream requests** (client-initiated): Use `U` prefix, e.g., `UEchoRequest`, `UEchoResponse`
- **Downstream requests** (server-initiated): Use `D` prefix, e.g., `DNotifyRequest`, `DNotifyResponse`
- **Common types**: No prefix needed, e.g., `PingPong`, `ByteStreamOperation`, `TraceContext`
- **Field names**: Use camelCase, e.g., `uEchoRequest`, `dNotifyResponse`

Example proto structure:

```protobuf
// Upstream (client-initiated)
message UEchoRequest { string message = 1; }
message UEchoResponse { string message = 1; }

// Downstream (server-initiated)
message DNotifyRequest { string notification = 1; }
message DNotifyResponse { bool acknowledged = 1; }

message ClientMessage {
  string requestId = 1;
  bool reply = 2;
  // ...
  oneof request {
    UEchoRequest uEchoRequest = 1000;      // client sends requests
    DNotifyResponse dNotifyResponse = 2000; // client sends responses to server
  }
}

message ServerMessage {
  string requestId = 1;
  bool reply = 2;
  // ...
  oneof response {
    UEchoResponse uEchoResponse = 1000;    // server responds to client
    DNotifyRequest dNotifyRequest = 2000;   // server sends requests to client
  }
}
```

**Note:** No `service` definition is needed in the proto file. SRPC uses ts-proto generated types directly.

## Architecture Overview

- **SrpcServer** orchestrates authentication, connection bookkeeping, message routing, and stream management.
- **SrpcServerWsHost** exposes the server over WebSocket.
- **SrpcClient** establishes a long-lived duplex stream to an SRPC server via WebSocket and handles reconnect logic, ping/pong heartbeats, and request routing.
- **SrpcByteStream** multiplexes binary substreams across an existing SRPC connection.
- `types.ts` defines the shared message contracts used by both server and client code.

## Proto TypeScript Generation

Generate TypeScript types from proto files (encode/decode functions are included by default):

```bash
# Generate types with encode/decode (default, required for SRPC)
dksf-gen-proto resources/proto/my-service.proto src/generated/my-service

# Additional options
dksf-gen-proto input.proto output --use-date --use-map-type

# Generate types only (no encode/decode)
dksf-gen-proto input.proto output --only-types
```

The generated module exports both the interface and a const with encode/decode methods:

```ts
export interface ClientMessage { ... }
export const ClientMessage: MessageFns<ClientMessage> = { encode, decode, ... }
```

## Server Setup

Construct a server by supplying logger, ts-proto generated message types, and the WebSocket path:

```ts
import { SrpcServer } from '../srpc/SrpcServer';
import { createLogger } from '../services';
import { ClientMessage, ServerMessage } from '../generated/my-service';

const server = new SrpcServer<SrpcMeta, ClientMessage, ServerMessage>({
    logger: createLogger('SRPC'),
    clientMessage: ClientMessage, // ts-proto generated type with encode/decode
    serverMessage: ServerMessage, // ts-proto generated type with encode/decode
    wsPath: '/srpc',
    debug: false
});
```

### Handling Client Requests

Register request handlers using just the prefix (e.g., `'uEcho'` not `'uEchoRequest'`):

```ts
server.registerMessageHandler('uEcho', async (stream, payload) => {
    // `payload` is the UEchoRequest message
    // `stream` exposes connection metadata and SrpcByteStream support
    return {
        message: `Echo: ${payload.message}`
    }; // Returned as UEchoResponse
});
```

Handlers may be plain functions or classes with a `handle()` method. Use `registerConnectionHandler()` / `registerDisconnectHandler()` to react to lifecycle events, and `invoke()` to call back into the connected client (using `D` prefix for downstream/server-initiated).

### Authentication

Out of the box the server validates HMAC signatures generated from `SRPC_AUTH_SECRET`. Override the behaviour by calling:

- `setClientAuthorizer(async meta => boolean | SrpcMeta)` – perform custom checks or enrich metadata.
- `setClientKeyFetcher(async clientId => secret | false)` – provide per-client secrets.

Both server and client enforce a ±`SRPC_AUTH_CLOCK_DRIFT_MS` timestamp tolerance (default 30s).

## Client Usage

```ts
import { SrpcClient } from '../srpc';
import { createLogger } from '../services';
import { ClientMessage, ServerMessage } from '../generated/my-service';

const client = new SrpcClient<ClientMessage, ServerMessage>(
    createLogger('SRPCClient'),
    'ws://localhost:3000/srpc', // Full WebSocket URL with path
    ClientMessage, // ts-proto generated type with encode/decode
    ServerMessage, // ts-proto generated type with encode/decode
    'client-id-123', // cid
    { appEnv: 'local' }, // Optional custom metadata
    process.env.SRPC_AUTH_SECRET // Optional override (falls back to config)
);

client.registerConnectionHandler(() => console.log('connected'));
client.registerDisconnectHandler(cause => console.log('disconnected:', cause));
client.connect();

// Invoke upstream request (just the prefix, no Request/Response suffix)
const response = await client.invoke('uEcho', { message: 'hello' });
```

### Client-side Request Handlers

The client supports server-initiated (downstream) requests. Register handlers using just the prefix to let the server initiate work on the connected client:

```ts
client.registerMessageHandler('dNotify', async payload => {
    console.log('Server notification:', payload.notification);
    return { acknowledged: true };
});
```

### Connection Health Checks

Use `triggerConnectionCheck()` to proactively detect stale connections:

```ts
// Sends a ping and expects a pong before the next ping interval
// If no response, the connection will be reset
client.triggerConnectionCheck();
```

## Byte Streams

Use `SrpcByteStream` to tunnel binary data across the existing SRPC connection without opening a new transport:

```ts
// Sender (client-side)
const outStream = SrpcByteStream.createSender(client);
outStream.end(Buffer.from('payload'));
await client.invoke('uUpload', { streamId: outStream.id, filename: 'data.bin' });

// Receiver (server-side)
server.registerMessageHandler('uUpload', async (stream, payload) => {
    const receiver = SrpcByteStream.createReceiver(stream, payload.streamId);
    const chunks: Buffer[] = [];
    for await (const chunk of receiver) chunks.push(chunk);
    await storeFile(payload.filename, Buffer.concat(chunks));
    return { message: 'Upload complete', bytesReceived: Buffer.concat(chunks).length };
});
```

`SrpcByteStream` automatically cleans up on disconnect and exposes helpers to propagate remote errors.

## Configuration Notes

- Set `SRPC_AUTH_SECRET` and optionally `SRPC_AUTH_CLOCK_DRIFT_MS`.
- Use `USE_REAL_IP_HEADER` in `BaseAppConfig` if you want to trust reverse-proxy headers for peer addresses.
- For observability, tracing hooks (`withSpan`, `withRemoteSpan`) are already wired into request handling.
