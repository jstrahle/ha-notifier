/**
 * Session token format.
 *
 * The cookie carries three fields, separated by dots, and is signed by
 * @fastify/cookie so it cannot be forged:
 *
 *     <userId>.<sessionVersion>.<issuedAtMs>
 *
 * Why not just the user id (which is what this used to be):
 *
 *  - `sessionVersion` is compared against the column of the same name on the
 *    user row. Bumping that column invalidates every existing cookie for that
 *    user, which is what makes "log out all devices" and "changing a password
 *    kicks out other devices" possible at all. A bare user id can never be
 *    revoked short of rotating SESSION_SECRET and logging everyone out.
 *
 *  - `issuedAtMs` lets us slide the expiry: an actively used app re-issues the
 *    cookie in the background, so it never reaches its deadline. Without it, a
 *    fixed max-age logs you out on a schedule no matter how much you use the
 *    app — which for an alerting tool means discovering you are logged out at
 *    the exact moment an alert arrives.
 */

export interface SessionToken {
  userId: string;
  version: number;
  issuedAt: number;
}

export function encodeSession(
  userId: string,
  version: number,
  issuedAt: number = Date.now(),
): string {
  return `${userId}.${version}.${issuedAt}`;
}

export function decodeSession(raw: string): SessionToken | null {
  const parts = raw.split('.');
  if (parts.length !== 3) return null;

  const [userId, versionStr, issuedAtStr] = parts;
  if (!userId || !versionStr || !issuedAtStr) return null;

  const version = Number(versionStr);
  const issuedAt = Number(issuedAtStr);
  if (!Number.isInteger(version) || !Number.isFinite(issuedAt)) return null;
  if (version < 1 || issuedAt <= 0) return null;

  return { userId, version, issuedAt };
}

/**
 * Whether the cookie is old enough to be worth re-issuing.
 *
 * We refresh well before expiry but not on every single request — re-issuing
 * once a day keeps an active session alive indefinitely while adding at most one
 * Set-Cookie header per day.
 */
export function shouldRenew(
  token: SessionToken,
  now: number,
  renewAfterMs: number,
): boolean {
  return now - token.issuedAt >= renewAfterMs;
}
