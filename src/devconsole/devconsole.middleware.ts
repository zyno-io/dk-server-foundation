import { createHttpError, HttpRequest, HttpResponse } from '@deepkit/http';

import { HttpMiddleware } from '../http/middleware';

const HttpForbiddenError = createHttpError(403, 'Forbidden');

export function isLocalhostDirect(request: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }): boolean {
    // Reject if request was forwarded through a reverse proxy
    if (request.headers['x-forwarded-for'] || request.headers['x-real-ip']) {
        return false;
    }
    const ip = request.socket.remoteAddress ?? '';
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return normalized === '127.0.0.1' || ip === '::1';
}

export class DevConsoleLocalhostMiddleware extends HttpMiddleware {
    handle(request: HttpRequest, _response: HttpResponse) {
        if (!isLocalhostDirect(request)) {
            throw new HttpForbiddenError();
        }
    }
}
