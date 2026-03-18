import { eventDispatcher } from '@deepkit/event';
import { HttpRequest, HttpResponse, HttpRouter, httpWorkflow } from '@deepkit/http';

export const CorsHeaders = Symbol('CorsHeaders');

export class HttpCorsOptionsMulti {
    constructor(public readonly options: HttpCorsOptions[]) {}
}

export class HttpCorsOptions {
    hosts!: (string | RegExp)[];
    paths?: (string | RegExp)[];
    methods?: string[];
    credentials?: boolean;
    allowHeaders?: string[];
    exposeHeaders?: string[];
}

export class HttpCors {
    static getResponseHeaders(response: HttpResponse): Record<string, string> | undefined {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (response as any)[CorsHeaders];
    }
}

export class HttpCorsDescriptor {
    cachedPreflightHeaders: Record<string, string> = {};
    cachedResponseCorsHeaders: Record<string, string> = {};

    constructor(public readonly options: HttpCorsOptions) {
        this.cachedPreflightHeaders['Access-Control-Allow-Methods'] = options.methods?.join(',') ?? 'GET,HEAD,PUT,PATCH,POST,DELETE';

        if (options.allowHeaders) {
            this.cachedPreflightHeaders['Access-Control-Allow-Headers'] = options.allowHeaders.join(', ');
        }

        if (options.credentials) {
            this.cachedPreflightHeaders['Access-Control-Allow-Credentials'] = 'true';
            this.cachedResponseCorsHeaders['Access-Control-Allow-Credentials'] = 'true';
        }

        if (options.exposeHeaders) {
            this.cachedResponseCorsHeaders['Access-Control-Expose-Headers'] = options.exposeHeaders.join(', ');
        }
    }
}

export class HttpCorsListener {
    descriptors: HttpCorsDescriptor[];

    constructor(
        protected router: HttpRouter,
        protected corsOptionsMulti: HttpCorsOptionsMulti
    ) {
        this.descriptors = corsOptionsMulti.options.map(options => new HttpCorsDescriptor(options));
    }

    // because DK's middleware implemtnation only aborts executing middleware when it encounters a finshed response,
    // we perform writeHead+end in our HttpMiddleware wrapper. this means that the response is already finished
    // by the time it would reach an onResponse handler, and would prevent us from injecting CORS headers into
    // a response such as an HTTP 401. to work around this, we precompute the CORS response headers so they can
    // be used in the normal response flow, or in our HttpMiddleware wrapper
    // note we already have a listener at priority 99, so we use 98 here since it needs to run before that one
    @eventDispatcher.listen(httpWorkflow.onRoute, 98)
    async onRoute(event: typeof httpWorkflow.onRoute.event): Promise<void> {
        if (event.sent) return;
        if (event.hasNext()) return;

        const descriptor = this.findMatchingDescriptor(event.request);
        if (descriptor) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (event.response as any)[CorsHeaders] = this.getCorsResponseHeaders(event.request, descriptor);
        }
    }

    @eventDispatcher.listen(httpWorkflow.onRouteNotFound, 99)
    async routeNotFound(event: typeof httpWorkflow.onRouteNotFound.event): Promise<void> {
        if (event.sent) return;
        if (event.hasNext()) return;

        if (event.request.method === 'OPTIONS') {
            const descriptor = this.findMatchingDescriptor(event.request);
            if (descriptor) {
                // DK's response requires a content-type, which doesn't make sense here, so we go around it
                // by using Node's built-in server response
                event.response.writeHead(204, this.getCorsPreflightHeaders(event.request, descriptor));
                event.response.end();
                event.send(event.response);
            }
        }
    }

    @eventDispatcher.listen(httpWorkflow.onResponse, -101)
    async onResponse(event: typeof httpWorkflow.onResponse.event): Promise<void> {
        if (event.response.headersSent) return;
        if (event.hasNext()) return;

        if (CorsHeaders in event.response) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const key in (event.response as any)[CorsHeaders]) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                event.response.setHeader(key, (event.response as any)[CorsHeaders][key]);
            }
        }
    }

    private findMatchingDescriptor(request: HttpRequest) {
        const originHeader = request.headers.origin;
        if (!originHeader) return null;
        if (!request.url) return null;

        const urlPath = request.url.split('?')[0];

        return this.descriptors.find(descriptor => {
            const hostMatches = descriptor.options.hosts.some(host => {
                if (host === '*') {
                    return true;
                }
                if (host instanceof RegExp) {
                    return host.test(originHeader);
                }
                return host === request.headers.origin;
            });

            const patchMatches =
                !descriptor.options.paths ||
                descriptor.options.paths.some(path => {
                    if (path instanceof RegExp) {
                        return path.test(urlPath);
                    }
                    return urlPath.startsWith(path);
                });

            return hostMatches && patchMatches;
        });
    }

    private getCorsPreflightHeaders(request: HttpRequest, descriptor: HttpCorsDescriptor): Record<string, string> {
        const headers: Record<string, string> = {
            ...descriptor.cachedPreflightHeaders,
            'Access-Control-Allow-Origin': request.headers.origin ?? '*',
            'Access-Control-Allow-Credentials': 'true',
            'Content-Length': '0'
        };

        if (!('Access-Control-Allow-Headers' in headers)) {
            if (request.headers['access-control-request-headers']) {
                headers['Access-Control-Allow-Headers'] = request.headers['access-control-request-headers'];
            }
        }

        return headers;
    }

    private getCorsResponseHeaders(request: HttpRequest, descriptor: HttpCorsDescriptor): Record<string, string> {
        return {
            ...descriptor.cachedResponseCorsHeaders,
            'Access-Control-Allow-Origin': request.headers.origin ?? '*'
        };
    }
}
