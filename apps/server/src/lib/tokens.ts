import { randomBytes, createHash } from 'node:crypto';

/**
 * Generates a URL-safe, cryptographically random token (default 32 bytes ->
 * 256 bits of entropy). Used for single-use SMS acknowledgement links, which
 * land in a text message and therefore must not be guessable.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hashes a secret (API key or token) for storage. We never persist the
 * plaintext of an API key; it is shown to the operator exactly once at
 * creation time. SHA-256 is sufficient for high-entropy random secrets.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function tokenExpiry(ttlSeconds: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + ttlSeconds * 1000);
}

export function isExpired(expiry: Date | null, now: Date = new Date()): boolean {
  if (!expiry) return false;
  return now.getTime() > expiry.getTime();
}
