import { describe, it, expect } from 'vitest';
import { encodeSession, decodeSession, shouldRenew } from '../session.js';

const DAY = 24 * 60 * 60 * 1000;

describe('session token', () => {
  it('round-trips', () => {
    const t = encodeSession('11111111-2222-3333-4444-555555555555', 3, 1_700_000_000_000);
    expect(decodeSession(t)).toEqual({
      userId: '11111111-2222-3333-4444-555555555555',
      version: 3,
      issuedAt: 1_700_000_000_000,
    });
  });

  it('rejects malformed tokens rather than trusting them', () => {
    expect(decodeSession('just-a-user-id')).toBeNull();     // the old format
    expect(decodeSession('user.abc.123')).toBeNull();        // version not a number
    expect(decodeSession('user.1.notatime')).toBeNull();
    expect(decodeSession('user.0.123')).toBeNull();          // version must be >= 1
    expect(decodeSession('')).toBeNull();
    expect(decodeSession('a.b')).toBeNull();
  });

  // The old cookie format was a bare user id. It must not be silently accepted
  // as a session, or version-based revocation could be bypassed by replaying it.
  it('does not accept a legacy bare-user-id cookie', () => {
    expect(decodeSession('11111111-2222-3333-4444-555555555555')).toBeNull();
  });
});

describe('sliding renewal', () => {
  const token = { userId: 'u', version: 1, issuedAt: 0 };

  it('renews once the cookie is a day old', () => {
    expect(shouldRenew(token, DAY, DAY)).toBe(true);
    expect(shouldRenew(token, 2 * DAY, DAY)).toBe(true);
  });

  it('does not renew on every request', () => {
    expect(shouldRenew(token, 1000, DAY)).toBe(false);
    expect(shouldRenew(token, DAY - 1, DAY)).toBe(false);
  });
});
