import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import type { ApiKeyPrincipal, UserPrincipal } from './auth.js';
import type { SessionToken } from './session.js';

/** Module augmentation so decorated properties are typed across the app. */
declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    ctx: AppContext;
  }
  interface FastifyRequest {
    session?: SessionToken;
    apiPrincipal?: ApiKeyPrincipal;
    userPrincipal?: UserPrincipal;
  }
}

export {};
