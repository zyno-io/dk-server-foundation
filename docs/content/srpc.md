# SRPC (Simple RPC)

Bidirectional RPC over WebSocket with HMAC authentication, ts-proto code generation, multiplexed binary streams, and OpenTelemetry tracing.

## Overview

SRPC uses a prefix-based message routing system. Messages are defined in `.proto` files and compiled to TypeScript with `dksf-gen-proto`. Prefixes determine direction:

- `u*` -- Upstream: client -> server requests
- `d*` -- Downstream: server -> client requests

## Proto Generation

Define messages in a `.proto` file:

```protobuf
syntax = "proto3";

message ClientMessage {
    string requestId = 1;
    bytes reply = 2;
    string error = 3;
    bytes trace = 4;
    bytes pingPong = 5;
    bytes byteStreamOperation = 6;

    // Upstream (client -> server)
    bytes uEcho = 100;
    bytes uGetUser = 101;

    // Downstream (server -> client)
    bytes dNotify = 200;
}

message ServerMessage {
    string requestId = 1;
    bytes reply = 2;
    string error = 3;
    bytes trace = 4;
    bytes pingPong = 5;
    bytes byteStreamOperation = 6;

    bytes uEcho = 100;
    bytes uGetUser = 101;
    bytes dNotify = 200;
}

// Request/response types
message UEchoRequest { string message = 1; }
message UEchoResponse { string message = 1; }
message UGetUserRequest { int32 id = 1; }
message UGetUserResponse { string name = 1; string email = 2; }
message DNotifyRequest { string event = 1; }
message DNotifyResponse { bool acknowledged = 1; }
```

Generate TypeScript:

```bash
dksf-gen-proto my-service.proto src/generated/proto/my-service
```

Options:

| Flag             | Description                        |
| ---------------- | ---------------------------------- |
| `--use-date`     | Use `Date` instead of `Timestamp`  |
| `--use-map-type` | Use `Map` instead of plain objects |
| `--only-types`   | Generate only type definitions     |

## Server

```typescript
import { SrpcServer } from '@signal24/dk-server-foundation';
import { ClientMessage, ServerMessage } from './generated/proto/my-service';

const server = new SrpcServer({
    logger: myLogger,
    clientMessage: ClientMessage,
    serverMessage: ServerMessage,
    wsPath: '/rpc'
});

// Handle new connections
server.registerConnectionHandler(async stream => {
    console.log(`Client connected: ${stream.clientId}`);
    stream.meta = { userId: stream.clientId };
});

// Handle upstream messages (client -> server)
server.registerMessageHandler('uEcho', async (stream, data) => {
    return { message: data.message };
});

server.registerMessageHandler('uGetUser', async (stream, data) => {
    const user = await db.query(User).filter({ id: data.id }).findOne();
    return { name: user.name, email: user.email };
});

// Handle disconnections
server.registerDisconnectHandler(async (stream, cause) => {
    console.log(`Client ${stream.clientId} disconnected: ${cause}`);
});
```

### Invoking Client Methods (Server -> Client)

```typescript
// Send to a specific client
const stream = server.streamsById.get(streamId);
const result = await server.invoke(stream, 'dNotify', { event: 'orderUpdated' });

// Create a reusable invoke function
const invoke = SrpcServer.createInvoke(() => server);
await invoke(stream, 'dNotify', { event: 'orderUpdated' }, 5000);
```

### `ISrpcServerOptions`

| Option          | Type             | Description                            |
| --------------- | ---------------- | -------------------------------------- |
| `logger`        | `ScopedLogger`   | Logger instance                        |
| `clientMessage` | `SrpcMessageFns` | ts-proto generated client message type |
| `serverMessage` | `SrpcMessageFns` | ts-proto generated server message type |
| `wsPath`        | `string`         | WebSocket path (e.g., `/rpc`)          |
| `debug`         | `boolean`        | Enable debug logging                   |

### Server Properties

| Property            | Type                      | Description                     |
| ------------------- | ------------------------- | ------------------------------- |
| `streamsById`       | `Map<string, SrpcStream>` | All active streams by stream ID |
| `streamsByClientId` | `Map<string, SrpcStream>` | Active streams by client ID     |

### Authentication

Default authentication uses HMAC signatures with clock drift tolerance:

```typescript
// Override authorization logic
server.setClientAuthorizer(async (clientId, signature, timestamp) => {
    // Custom auth logic
    return isValid;
});

// Provide per-client secrets
server.setClientKeyFetcher(async clientId => {
    return await getClientSecret(clientId);
});
```

Configure via `SRPC_AUTH_SECRET` and `SRPC_AUTH_CLOCK_DRIFT_MS` (default: 30 seconds).

## Client

```typescript
import { SrpcClient } from '@signal24/dk-server-foundation';
import { ClientMessage, ServerMessage } from './generated/proto/my-service';

const client = new SrpcClient(
    logger,
    'wss://api.example.com/rpc',
    ClientMessage,
    ServerMessage,
    'client-id-123',
    { role: 'worker' }, // Optional metadata
    'shared-secret', // Optional auth secret
    { enableReconnect: true } // Options
);

client.connect(); // Non-async: initiates connection in background

// Handle downstream messages (server -> client)
client.registerMessageHandler('dNotify', async data => {
    console.log(`Event: ${data.event}`);
    return { acknowledged: true };
});

// Invoke upstream messages (client -> server)
const result = await client.invoke('uEcho', { message: 'hello' });
console.log(result.message); // 'hello'

// Connection lifecycle
client.registerConnectionHandler(async () => {
    /* connected */
});
client.registerDisconnectHandler(async cause => {
    /* disconnected */
});

// Check connection status
if (client.isConnected) {
    /* ... */
}

// Disconnect (non-async: closes connection immediately)
client.disconnect();
```

### `SrpcClientOptions`

| Option            | Type      | Default | Description                  |
| ----------------- | --------- | ------- | ---------------------------- |
| `enableReconnect` | `boolean` | `true`  | Auto-reconnect on disconnect |

## Binary Streams

`SrpcByteStream` provides multiplexed binary streaming over existing SRPC connections. Streams are `Duplex` node streams with backpressure support.

```typescript
// Sender side
const sender = SrpcByteStream.createSender(stream);
sender.write(buffer);
sender.end();

// Receiver side (via handler)
const receiver = SrpcByteStream.createReceiver(stream, streamId);
receiver.on('data', chunk => {
    /* process binary data */
});
receiver.on('end', () => {
    /* stream finished */
});
```

### Constants

| Constant                     | Value     | Description                                 |
| ---------------------------- | --------- | ------------------------------------------- |
| `HIGH_WATER_MARK`            | 256 KB    | WebSocket buffer threshold for backpressure |
| `PENDING_RECEIVER_MAX_BYTES` | 2 MB      | Max buffer before receiver is created       |
| `PENDING_RECEIVER_TTL_MS`    | 5 seconds | Timeout for pending receiver data           |

## Disconnect Causes

```typescript
type SrpcDisconnectCause = 'disconnect' | 'duplicate' | 'timeout' | 'badArg';
```

| Cause        | Description                                |
| ------------ | ------------------------------------------ |
| `disconnect` | Normal disconnection                       |
| `duplicate`  | Another connection with the same client ID |
| `timeout`    | Heartbeat timeout                          |
| `badArg`     | Invalid connection arguments               |

## Error Handling

```typescript
import { SrpcError } from '@signal24/dk-server-foundation';

// Throw user-facing errors in handlers
throw new SrpcError('Invalid input', true); // isUserError: true

// Non-user errors are logged but return generic message to client
throw new SrpcError('Internal failure', false);
```

## OpenTelemetry Integration

SRPC automatically propagates trace context between client and server. Spans are created for each RPC call with the message prefix as the span name.
