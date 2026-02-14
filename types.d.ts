declare module 'opentelemetry-node-metrics' {
    // unclear why I can't import @opentelemetry/api without this file blowing up
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export default function (provider: any): void;
}

declare module 'send' {
    import { IncomingMessage } from 'http';
    import { Stream } from 'stream';

    interface SendStream extends Stream {
        on(event: 'error', fn: (err: { status: number }) => void): this;
        on(event: 'end', fn: () => void): this;
        pipe<T extends NodeJS.WritableStream>(destination: T): T;
    }

    function send(req: IncomingMessage, path: string, options?: { root?: string }): SendStream;
    export = send;
}
