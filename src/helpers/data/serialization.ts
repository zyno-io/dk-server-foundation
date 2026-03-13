import { Serializable } from '../../types';

export function toJson(data: Serializable) {
    return JSON.stringify(data);
}

export function fromJson<T>(serialized: string): T {
    return JSON.parse(serialized);
}

/**
 * JSON.stringify that replaces true circular references with '[Circular]'.
 * Shared (non-circular) object references are serialized normally.
 */
export function safeJsonStringify(data: unknown): string {
    const ancestors: object[] = [];
    return JSON.stringify(data, function (_key, value) {
        if (typeof value !== 'object' || value === null) return value;
        // Walk up from the end; `this` is the parent object holding `_key`
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
            ancestors.pop();
        }
        if (ancestors.includes(value)) return '[Circular]';
        ancestors.push(value);
        return value;
    });
}
