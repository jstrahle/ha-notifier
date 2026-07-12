import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { apiKeys, tenants, users } from '../db/schema.js';
import { hashSecret } from './tokens.js';
import type { AppConfig } from '../config.js';

/**
 * Two authentication modes:
 *  - Bearer API keys for senders (home automation). Scoped ('notify'|'admin').
 *  - Signed session cookies for PWA users, set on login.
 */

export interface ApiKeyPrincipal {
  kind: 'apikey';
  tenantId: string;
  scopes: string[];
}

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  tenantId: string;
  role: string;
}

export async function verifyApiKey(
  db: Db,
  authorizationHeader: string | undefined,
): Promise<ApiKeyPrincipal | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  const plaintext = authorizationHeader.slice('Bearer '.length).trim();
  if (!plaintext) return null;

  const keyHash = hashSecret(plaintext);
  const row = (
    await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1)
  )[0];
  if (!row) return null;

  // Best-effort last-used timestamp; not on the hot path for correctness.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});

  return { kind: 'apikey', tenantId: row.tenantId, scopes: row.scopes };
}

/** The single tenant for the MVP. */
export async function getSingleTenantId(db: Db): Promise<string> {
  const t = (await db.select({ id: tenants.id }).from(tenants).limit(1))[0];
  if (!t) throw new Error('No tenant found — run the seed script');
  return t.id;
}

/** Guard: require a Bearer key with the given scope. */
export function requireApiScope(scope: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await verifyApiKey(
      req.server.db,
      req.headers.authorization,
    );
    if (!principal) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid API key' } });
    }
    if (!principal.scopes.includes(scope) && !principal.scopes.includes('admin')) {
      return reply.code(403).send({ error: { code: 'forbidden', message: `Requires scope: ${scope}` } });
    }
    req.apiPrincipal = principal;
  };
}

/**
 * Cookie settings for the session. Kept in one place so login, renewal and
 * logout cannot drift apart — a mismatch in `path` or `sameSite` silently
 * creates a second cookie instead of replacing the first.
 */
export function sessionCookieOptions(config: AppConfig, maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.NODE_ENV === 'production',
    signed: true,
    maxAge: maxAgeSeconds,
  };
}

/** Guard: require a logged-in PWA user (session cookie). */
export function requireUser(adminOnly = false) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const session = req.session;
    if (!session?.userId) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Login required' } });
    }
    const user = (
      await req.server.db.select().from(users).where(eq(users.id, session.userId)).limit(1)
    )[0];
    if (!user) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Unknown user' } });
    }

    // A cookie issued before the user's session version was bumped is dead.
    // This is what makes "log out all devices" and password changes actually
    // revoke access rather than merely look like they do.
    if (session.version !== user.sessionVersion) {
      reply.clearCookie('sid', { path: '/' });
      return reply.code(401).send({
        error: { code: 'session_revoked', message: 'Session no longer valid — please sign in again' },
      });
    }

    if (adminOnly && user.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Admin only' } });
    }
    req.userPrincipal = {
      kind: 'user',
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    };
  };
}

export async function findActiveUser(db: Db, userId: string) {
  return (
    await db.select().from(users).where(and(eq(users.id, userId))).limit(1)
  )[0];
}
