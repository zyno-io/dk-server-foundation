import { resolve } from 'path';

import { http, HttpNotFoundError, HttpRequest, HttpResponse } from '@deepkit/http';
import send from 'send';

import { serializeOpenApiSchema } from '../app/dev';
import { globalState } from '../app/state';
import { DevConsoleLocalhostMiddleware } from './devconsole.middleware';

const STATIC_DIR = resolve(__dirname, '../../devconsole');

function serveStatic(req: HttpRequest, res: HttpResponse, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        send(req, path, { root: STATIC_DIR })
            .on('error', (err: { status: number }) => {
                if (err.status === 404) {
                    reject(new HttpNotFoundError());
                } else {
                    reject(err);
                }
            })
            .on('end', resolve)
            .pipe(res);
    });
}

@(http.controller('/_devconsole').middleware(DevConsoleLocalhostMiddleware))
export class DevConsoleController {
    @http.GET('')
    serveIndex(req: HttpRequest, res: HttpResponse): Promise<void> {
        return serveStatic(req, res, 'index.html');
    }

    @http.GET('assets/:path')
    serveAsset(path: string, req: HttpRequest, res: HttpResponse): Promise<void> {
        return serveStatic(req, res, `assets/${path}`);
    }

    @http.GET('openapi.json')
    serveOpenApiSchema(res: HttpResponse): void {
        const app = globalState.currentApp;
        if (!app) {
            res.status(503);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'App not ready' }));
            return;
        }

        try {
            const schema = serializeOpenApiSchema(app);
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(schema, undefined, 2));
        } catch (err) {
            res.status(500);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: String(err) }));
        }
    }
}
