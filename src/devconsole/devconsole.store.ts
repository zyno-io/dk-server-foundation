export class RingBuffer<T> {
    private buffer: (T | undefined)[];
    private head = 0;
    private count = 0;

    constructor(private capacity: number) {
        this.buffer = Array.from({ length: capacity });
    }

    push(item: T): void {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
    }

    toArray(): T[] {
        if (this.count === 0) return [];
        if (this.count < this.capacity) {
            return this.buffer.slice(0, this.count) as T[];
        }
        return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)] as T[];
    }

    get length(): number {
        return this.count;
    }
}

export interface DevConsoleErrorInfo {
    name: string;
    message: string;
    stack?: string;
    cause?: DevConsoleErrorInfo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

export interface DevConsoleHttpEntry {
    id: string;
    timestamp: number;
    method: string;
    url: string;
    remoteAddress: string;
    requestHeaders: Record<string, string | string[] | undefined>;
    requestBody: string | null;
    statusCode: number;
    responseHeaders: Record<string, string | string[] | undefined>;
    responseBody: string | null;
    durationMs: number;
    error?: DevConsoleErrorInfo;
}

export interface DevConsoleSrpcMessage {
    id: string;
    timestamp: number;
    streamId: string;
    clientId: string;
    direction: 'inbound' | 'outbound';
    messageType: string;
    isReply: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>;
    error?: string;
    isUserError?: boolean;
}

export interface DevConsoleSrpcConnection {
    streamId: string;
    clientId: string;
    clientStreamId: string;
    appVersion: string;
    address: string;
    connectedAt: number;
    lastPingAt: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: Record<string, any>;
    messageCount: number;
}

export interface DevConsoleSrpcDisconnection {
    streamId: string;
    clientId: string;
    disconnectedAt: number;
    cause: string;
}

export interface DevConsoleMutexEntry {
    id: string;
    key: string;
    status: 'pending' | 'acquired' | 'released' | 'error' | 'failed';
    startedAt: number;
    acquiredAt?: number;
    releasedAt?: number;
    durationMs?: number;
    waitDurationMs?: number;
    waited?: boolean;
    error?: string;
}

export class DevConsoleStore {
    private static instance: DevConsoleStore | null = null;

    readonly httpEntries = new RingBuffer<DevConsoleHttpEntry>(500);
    readonly srpcMessages = new RingBuffer<DevConsoleSrpcMessage>(500);
    readonly srpcConnections = new Map<string, DevConsoleSrpcConnection>();
    readonly srpcDisconnected = new RingBuffer<DevConsoleSrpcDisconnection>(50);
    readonly mutexEntries = new RingBuffer<DevConsoleMutexEntry>(200);
    readonly activeMutexes = new Map<string, DevConsoleMutexEntry>();
    readonly startedAt = Date.now();

    onEvent?: (type: string, data: unknown) => void;

    addHttpEntry(entry: DevConsoleHttpEntry) {
        this.httpEntries.push(entry);
        this.onEvent?.('http:entry', entry);
    }

    addSrpcMessage(msg: DevConsoleSrpcMessage) {
        this.srpcMessages.push(msg);
        this.onEvent?.('srpc:message', msg);
    }

    addSrpcConnection(conn: DevConsoleSrpcConnection) {
        this.srpcConnections.set(conn.streamId, conn);
        this.onEvent?.('srpc:connection', conn);
    }

    removeSrpcConnection(streamId: string, clientId: string, cause: string) {
        this.srpcConnections.delete(streamId);
        const disc: DevConsoleSrpcDisconnection = { streamId, clientId, disconnectedAt: Date.now(), cause };
        this.srpcDisconnected.push(disc);
        this.onEvent?.('srpc:disconnection', disc);
    }

    addMutexPending(entry: DevConsoleMutexEntry) {
        this.mutexEntries.push(entry);
        this.activeMutexes.set(entry.id, entry);
        this.onEvent?.('mutex:pending', entry);
    }

    updateMutexAcquired(id: string, waited: boolean) {
        const entry = this.activeMutexes.get(id);
        if (entry) {
            entry.status = 'acquired';
            entry.acquiredAt = Date.now();
            entry.waitDurationMs = entry.acquiredAt - entry.startedAt;
            entry.waited = waited;
            this.onEvent?.('mutex:acquired', entry);
        }
    }

    updateMutexReleased(id: string) {
        const entry = this.activeMutexes.get(id);
        if (entry) {
            entry.status = 'released';
            entry.releasedAt = Date.now();
            entry.durationMs = entry.releasedAt - (entry.acquiredAt ?? entry.startedAt);
            this.activeMutexes.delete(id);
            this.onEvent?.('mutex:released', entry);
        }
    }

    updateMutexError(id: string, err: unknown) {
        const entry = this.activeMutexes.get(id);
        if (entry) {
            entry.status = 'error';
            entry.releasedAt = Date.now();
            entry.durationMs = entry.releasedAt - (entry.acquiredAt ?? entry.startedAt);
            entry.error = err instanceof Error ? err.message : String(err);
            this.activeMutexes.delete(id);
            this.onEvent?.('mutex:error', entry);
        }
    }

    addMutexFailed(entry: DevConsoleMutexEntry) {
        this.mutexEntries.push(entry);
        this.onEvent?.('mutex:failed', entry);
    }

    static init(): DevConsoleStore {
        if (!this.instance) {
            this.instance = new DevConsoleStore();
        }
        return this.instance;
    }

    static get(): DevConsoleStore | null {
        return this.instance;
    }
}
