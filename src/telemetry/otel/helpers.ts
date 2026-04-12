import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

import { Attributes, Link, ROOT_CONTEXT, Span, SpanKind, SpanStatusCode, trace, Tracer } from '@opentelemetry/api';
import { isNativeError } from 'util/types';

export const OtelState = {
    tracer: undefined as Tracer | undefined,
    prometheusExporter: undefined as PrometheusExporter | undefined,

    get installed() {
        return OtelState.tracer !== undefined;
    }
};

export function isTracingInstalled() {
    return OtelState.installed;
}

export function getTracer() {
    return OtelState.tracer;
}

export function getActiveSpan() {
    return trace.getActiveSpan();
}

export function getTraceContext() {
    return getActiveSpan()?.spanContext();
}

export function disableActiveTrace() {
    const ctx = getTraceContext();
    if (ctx) {
        ctx.traceFlags = 0;
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isError(e: any): e is Error {
    return e instanceof Error || isNativeError(e);
}

async function runInSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
    try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
    } catch (err) {
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: isError(err) ? err.message : String(err)
        });
        throw err;
    } finally {
        span.end();
    }
}

type SpanInfo =
    | {
          traceId: string;
          spanId: string;
          traceFlags?: number;
      }
    | { traceparent: string }
    | undefined;

export function withRemoteSpan<T>(name: string, spanInfo: SpanInfo, attrs: Attributes | undefined, fn: () => Promise<T>): Promise<T> {
    if (!OtelState.tracer) return fn();
    if (!spanInfo) return withSpan(name, attrs, fn);

    let traceId: string;
    let spanId: string;
    let traceFlags: number | undefined;

    if ('traceparent' in spanInfo) {
        const parts = spanInfo.traceparent.split('-');
        traceId = parts[1];
        spanId = parts[2];
    } else {
        traceId = spanInfo.traceId;
        spanId = spanInfo.spanId;
        traceFlags = spanInfo.traceFlags;
    }

    const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId,
        traceFlags: traceFlags ?? 1 /* sample by default */,
        isRemote: true
    });
    return OtelState.tracer.startActiveSpan(name, { attributes: attrs, kind: SpanKind.SERVER }, parentContext, span => runInSpan(span, fn));
}

export function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T>;
export function withSpan<T>(name: string, attrs: Attributes | undefined, fn: () => Promise<T>): Promise<T>;
export function withSpan<T>(name: string, attrsOrFn: Attributes | (() => T) | undefined, fn?: () => Promise<T>): Promise<T> {
    const resolvedAttrs = typeof attrsOrFn === 'object' ? attrsOrFn : undefined;
    const resolvedFn = fn ?? (attrsOrFn as () => Promise<T>);

    if (!OtelState.tracer) return resolvedFn();
    return OtelState.tracer.startActiveSpan(name, { attributes: resolvedAttrs }, span => runInSpan(span, resolvedFn));
}

export function withRootSpan<T>(name: string, fn: () => Promise<T>): Promise<T>;
export function withRootSpan<T>(name: string, attrs: Attributes | undefined, fn: () => Promise<T>): Promise<T>;
export function withRootSpan<T>(name: string, attrsOrFn: Attributes | (() => T) | undefined, fn?: () => Promise<T>): Promise<T> {
    const resolvedAttrs = typeof attrsOrFn === 'object' ? attrsOrFn : undefined;
    const resolvedFn = fn ?? (attrsOrFn as () => Promise<T>);

    if (!OtelState.tracer) return resolvedFn();
    return OtelState.tracer.startActiveSpan(name, { attributes: resolvedAttrs }, ROOT_CONTEXT, span => runInSpan(span, resolvedFn));
}

/**
 * Start a root span with one or more span links — used to express "this trace is
 * caused by / related to that other trace" without chaining them as parent/child.
 */
export type SpanLinkRef = { traceId: string; spanId: string; attributes?: Attributes };

export function withLinkedRootSpan<T>(name: string, links: SpanLinkRef[], attrs: Attributes | undefined, fn: () => Promise<T>): Promise<T> {
    if (!OtelState.tracer) return fn();
    const otelLinks: Link[] = links.map(l => ({
        context: { traceId: l.traceId, spanId: l.spanId, traceFlags: 1, isRemote: true },
        attributes: l.attributes
    }));
    return OtelState.tracer.startActiveSpan(name, { attributes: attrs, links: otelLinks }, ROOT_CONTEXT, span => runInSpan(span, fn));
}

export function setSpanAttributes(attributes: Attributes) {
    if (!OtelState.installed) return;
    getActiveSpan()?.setAttributes(attributes);
}
