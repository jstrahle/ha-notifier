import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing using Node's built-in scrypt.
 *
 * We deliberately avoid argon2 here: it is a native addon that must be compiled
 * per platform/libc, which forces build toolchains into the (Alpine/musl) image
 * and breaks cleanly-prebuilt multi-arch deployments. scrypt is a memory-hard
 * KDF in the Node core crypto module — no native dependency, no supply chain,
 * works identically on glibc and musl.
 *
 * Format: scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
 */
const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEYLEN);
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  stored: string,
  password: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!saltB64 || !hashB64) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, salt, expected.length);

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
