import type { DevConsoleStore } from './devconsole.store';
import type { SrpcStream } from '../srpc/types';

export interface SrpcMessageObserver {
    onInboundMessage?(stream: SrpcStream, messageType: string, data: Record<string, unknown>): void;
    onOutboundMessage?(stream: SrpcStream, messageType: string, data: Record<string, unknown>): void;
    onConnectionEstablished?(stream: SrpcStream): void;
    onConnectionClosed?(stream: SrpcStream, cause: string): void;
}

const BASE_MESSAGE_KEYS = new Set(['requestId', 'reply', 'error', 'userError', 'trace', 'pingPong', 'byteStreamOperation']);

function identifyMessageType(data: Record<string, unknown>): string {
    for (const key of Object.keys(data)) {
        if (!BASE_MESSAGE_KEYS.has(key) && data[key] != null) {
            return key;
        }
    }
    return 'unknown';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeData(data: Record<string, any>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        if (key === 'trace') continue;
        if (key === 'byteStreamOperation' && value) {
            result[key] = {
                streamId: value.streamId,
                operation: value.write ? 'write' : value.finish ? 'finish' : value.destroy ? 'destroy' : 'unknown'
            };
            continue;
        }
        result[key] = value;
    }
    return result;
}

export function createDevConsoleSrpcObserver(store: DevConsoleStore): SrpcMessageObserver {
    return {
        onInboundMessage(stream: SrpcStream, messageType: string, data: Record<string, unknown>) {
            const conn = store.srpcConnections.get(stream.id);
            if (conn) conn.messageCount++;

            store.addSrpcMessage({
                id: (data.requestId as string) ?? '',
                timestamp: Date.now(),
                streamId: stream.id,
                clientId: stream.clientId,
                direction: 'inbound',
                messageType,
                isReply: !!data.reply,
                data: sanitizeData(data),
                error: data.error as string | undefined,
                isUserError: data.userError as boolean | undefined
            });
        },

        onOutboundMessage(stream: SrpcStream, messageType: string, data: Record<string, unknown>) {
            store.addSrpcMessage({
                id: (data.requestId as string) ?? '',
                timestamp: Date.now(),
                streamId: stream.id,
                clientId: stream.clientId,
                direction: 'outbound',
                messageType,
                isReply: !!data.reply,
                data: sanitizeData(data),
                error: data.error as string | undefined,
                isUserError: data.userError as boolean | undefined
            });
        },

        onConnectionEstablished(stream: SrpcStream) {
            store.addSrpcConnection({
                streamId: stream.id,
                clientId: stream.clientId,
                clientStreamId: stream.clientStreamId,
                appVersion: stream.appVersion,
                address: stream.address,
                connectedAt: stream.connectedAt,
                lastPingAt: stream.lastPingAt,
                meta: stream.meta as Record<string, unknown>,
                messageCount: 0
            });
        },

        onConnectionClosed(stream: SrpcStream, cause: string) {
            store.removeSrpcConnection(stream.id, stream.clientId, cause);
        }
    };
}

export { identifyMessageType, sanitizeData };
