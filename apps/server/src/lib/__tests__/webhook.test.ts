import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature } from '../webhook.js';

const SECRET = 'a-shared-secret-value';

describe('action webhook signing', () => {
  it('verifies a signature it produced', () => {
    const body = JSON.stringify({ action_id: 'unlock' });
    const ts = '1700000000';
    const sig = signPayload(SECRET, ts, body);
    expect(verifySignature(SECRET, ts, body, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = '1700000000';
    const sig = signPayload(SECRET, ts, '{"action_id":"unlock"}');
    expect(verifySignature(SECRET, ts, '{"action_id":"disarm"}', sig)).toBe(false);
  });

  it('rejects a replayed body under a different timestamp', () => {
    const body = '{"action_id":"unlock"}';
    const sig = signPayload(SECRET, '1700000000', body);
    expect(verifySignature(SECRET, '1700009999', body, sig)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const body = '{"action_id":"unlock"}';
    const ts = '1700000000';
    const sig = signPayload('other-secret-value', ts, body);
    expect(verifySignature(SECRET, ts, body, sig)).toBe(false);
  });

  it('is prefixed so the algorithm is explicit to the receiver', () => {
    expect(signPayload(SECRET, '1', 'x')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
