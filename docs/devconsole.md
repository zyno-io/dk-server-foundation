# DevConsole

A built-in web dashboard for development-time monitoring and debugging. Automatically enabled when `APP_ENV !== 'production'` and accessible at `http://localhost:{PORT}/_devconsole/`.

DevConsole is zero-config, localhost-only, and requires no additional setup beyond running your app in development mode.

## Views

### Dashboard

App overview showing name, version, environment, uptime, and real-time statistics (HTTP request count, SRPC connections/messages). Also displays process info: PID, Node version, platform, CPU usage, and memory consumption.

### Routes

Lists all registered HTTP routes with their methods, paths, controller class, and handler method. Internal `/_devconsole` routes are excluded.

### OpenAPI

Displays the OpenAPI schema generated from your HTTP routes. The schema is generated on-demand from route metadata via `deepkit-openapi-core`.

### Requests

HTTP request inspector capturing the last 500 requests. Shows timestamp, method, URL, status code, duration, and remote address. Expanding a request reveals full request/response headers and bodies (up to 32KB), plus error details with stack traces for failed requests. New requests appear in real time.

### SRPC

SRPC connection monitor showing active connections (client ID, stream ID, app version, address, uptime, ping, message count) and recent disconnections. Includes a message-level inspector (last 500 messages) showing type, direction, request ID, reply status, and errors. Messages can be filtered by stream ID.

### Database

Entity browser listing all registered ORM entities with table names and columns. Includes a SQL query editor — `SELECT` queries return result rows, while `INSERT`/`UPDATE`/`DELETE` return affected row counts. Execute with Ctrl+Enter.

### Health

Displays results from all registered health checks with status (ok/error) and error messages.

### Mutex

Redis mutex monitor showing active mutexes (key, status, timing) and a history of the last 200 completed/failed acquisitions with wait and hold duration metrics.

### REPL

Interactive JavaScript REPL running in the server's context. Access DI-registered classes via `$` and instances via `$$`. Supports Tab-completion, command history (arrow keys), and multiline input (Shift+Enter). Console output (`log`, `warn`, `error`) is captured and displayed.

### Environment

Displays application configuration from the config class. Keys containing `SECRET`, `PASSWORD`, `DSN`, `TOKEN`, or `KEY` are masked.

### Workers

BullMQ job inspector showing queue statistics (active, waiting, delayed, completed, failed counts), live jobs, and job history (last 200 from the `_jobs` table).

## Architecture

### Transport

DevConsole uses SRPC over WebSocket (`/_devconsole/ws`) for bidirectional communication. The protocol is defined in `resources/proto/devconsole.proto` and uses Protocol Buffers for encoding.

Real-time events (new HTTP requests, SRPC messages, mutex state changes, worker jobs) are pushed from server to client without polling.

### Security

Access is restricted to localhost connections only. The `DevConsoleLocalhostMiddleware` checks that the request originates from `127.0.0.1` or `::1` using the socket's `remoteAddress` (not proxy headers). SRPC authentication is bypassed for DevConsole connections.

### How It Works

DevConsole initializes via `initDevConsole()` in `src/devconsole/patches.ts`, which monkey-patches core framework components to intercept events:

- **HTTP Kernel** — captures request/response data for the Requests view
- **HTTP Workflow** — captures controller errors
- **SRPC Client & Server** — observes messages and connection lifecycle
- **Worker Observer** — listens to BullMQ job events
- **Mutex (`withMutex`)** — tracks mutex acquisitions and releases

Captured data is stored in ring buffers (`DevConsoleStore`) for bounded memory usage.

### Frontend

The frontend is a Vue 3 SPA built with Vite. Source lives in `devconsole/` and builds to `dist/devconsole/`. The built assets are served by `DevConsoleController` at `/_devconsole/`.

In development, the frontend can be run standalone with `cd devconsole && npm run dev`, which proxies API and WebSocket requests to `localhost:3000`.

## Demo App

A demo application is included to showcase all DevConsole features:

```bash
yarn demoapp
```

This starts a server at `http://localhost:3000` with auto-generated HTTP traffic, SRPC client/server chatter, worker jobs, and mutex contention. Open `http://localhost:3000/_devconsole/` to see it all in action.
