import { HttpRequest, HttpUnauthorizedError, RouteParameterResolver, RouteParameterResolverContext } from '@deepkit/http';
import { ScopedLogger } from '@deepkit/logger';
import { ActiveRecordClassType } from '@deepkit/orm';
import { timingSafeEqual } from 'crypto';

// can't import app here or bad things happen!!
import type { BaseAppConfig } from '../app';

import { JWT, ParsedJwt } from '../auth';
import { getEntity, getEntityOrUndefined } from '../database';
import { HttpMiddleware } from './middleware';
import { createCachingParameterResolver, getCompositeCacheKey, getOrCacheValue } from './store';

/**
 * base request JWT lookup
 */
export async function getJwtFromRequest(request: HttpRequest): Promise<ParsedJwt | undefined> {
    return getOrCacheValue(request, ParsedJwt, _getJwtFromRequest);
}

async function _getJwtFromRequest(request: HttpRequest): Promise<ParsedJwt | undefined> {
    const jwt = await JWT.processWithRequest(request);
    if (!jwt) return undefined;
    if (!jwt.isValid) {
        if (!jwt.isSignatureValid) throw new HttpUnauthorizedError('Invalid JWT signature');
        if (!jwt.isNotExpired) throw new HttpUnauthorizedError('Expired JWT');
        throw new HttpUnauthorizedError('Invalid JWT');
    }
    return jwt;
}

export class ParsedJwtResolver implements RouteParameterResolver {
    async resolve(context: RouteParameterResolverContext): Promise<ParsedJwt | undefined> {
        const jwt = await getJwtFromRequest(context.request);
        if (!jwt && !context.type.isOptional()) {
            throw new HttpUnauthorizedError('Request does not contain required JWT');
        }
        return jwt;
    }
}

/**
 * base request JWT user ID lookup
 */
const EntityIdSymbol = Symbol('EntityId');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getEntityIdFromRequestJwt(request: HttpRequest): Promise<any> {
    const jwt = await getJwtFromRequest(request);
    return jwt?.subject;
}

/**
 * request JWT user ID to user object
 */
export async function getEntityFromRequestJwt<T extends ActiveRecordClassType>(
    request: HttpRequest,
    EntityClass: T
): Promise<InstanceType<T> | undefined> {
    const entityId = await getEntityIdFromRequestJwt(request);
    return entityId ? getEntity(EntityClass, entityId) : undefined;
}

/**
 * auth middleware generator
 */
interface EntityValidator<T extends ActiveRecordClassType> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getEntityIdFromRequest(request: HttpRequest): Promise<any>;
    validateEntity?(request: HttpRequest, entity: InstanceType<T>): Promise<void>;
}
export function createAuthMiddleware<T extends ActiveRecordClassType>(EntityClass: T) {
    return class extends HttpMiddleware implements EntityValidator<T> {
        async handle(request: HttpRequest) {
            const entityId = await getOrCacheValue(
                request,
                getCompositeCacheKey(EntityClass, EntityIdSymbol),
                this.getEntityIdFromRequest.bind(this)
            );
            await this.loadAndValidateEntity(request, entityId);
        }

        async getEntityIdFromRequest(request: HttpRequest) {
            const id = await getEntityIdFromRequestJwt(request);
            if (!id) throw new HttpUnauthorizedError();
            return id;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async loadAndValidateEntity(request: HttpRequest, id: any) {
            const validateFn = (this as EntityValidator<T>).validateEntity;
            if (validateFn) {
                const entity = await getOrCacheValue(request, EntityClass, () => getEntityOrUndefined(EntityClass, id));
                if (!entity) throw new HttpUnauthorizedError();
                await validateFn(request, entity);
            }
        }
    };
}

/**
 * HTTP basic auth middleware
 */
export function createBasicAuthMiddleware(expectedUsername?: string) {
    return class extends HttpMiddleware {
        public config: BaseAppConfig;

        constructor(public logger: ScopedLogger) {
            super();

            // todo:figure this out
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.config = require('../app').getAppConfig();
            if (!this.config.AUTH_BASIC_SECRET) {
                this.logger.error('No AUTH_BASIC_SECRET provided');
            }
        }

        async handle(request: HttpRequest) {
            const authHeader = request.headers['authorization'];
            if (!authHeader) {
                throw new HttpUnauthorizedError();
            }

            const [scheme, credentials] = authHeader.split(' ');
            if (scheme.toLowerCase() !== 'basic') {
                throw new HttpUnauthorizedError('Invalid authorization scheme');
            }

            const [username, password] = Buffer.from(credentials, 'base64').toString().split(':');
            const secret = this.config.AUTH_BASIC_SECRET ?? '';
            const usernameInvalid = expectedUsername && expectedUsername !== username;
            const passwordBuf = Buffer.from(password);
            const secretBuf = Buffer.from(secret);
            const passwordInvalid = passwordBuf.length !== secretBuf.length || !timingSafeEqual(passwordBuf, secretBuf);
            if (usernameInvalid || passwordInvalid) {
                throw new HttpUnauthorizedError('Invalid credentials');
            }
        }
    };
}

/**
 * standard authed entity resolver
 */
export async function resolveEntityFromRequestJwt<T extends ActiveRecordClassType>(context: RouteParameterResolverContext, EntityClass: T) {
    const ent = await getEntityFromRequestJwt(context.request, EntityClass);
    if (!ent && !context.type.isOptional()) {
        throw new HttpUnauthorizedError();
    }
    return ent;
}

export function createEntityFromRequestJwtParameterResolver<T extends ActiveRecordClassType>(EntityClass: T) {
    return createCachingParameterResolver(EntityClass, async (context: RouteParameterResolverContext) => {
        return resolveEntityFromRequestJwt(context, EntityClass);
    });
}
