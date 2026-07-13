import { describe, it, expect } from 'vitest';
import { toPublicActions } from '../actions.js';
import { withAckAction } from '../../workers/delivery.worker.js';

/**
 * An action's `url` is a Home Assistant webhook endpoint. Home Assistant's own
 * documentation says to treat a webhook ID like a password — and one that can
 * unlock a front door is exactly that.
 *
 * The client never needs it: pressing a button calls our own API, and the server
 * looks the URL up and makes the signed outbound call itself. Sending it to the
 * browser only copies a password onto every family member's phone, into every
 * notification payload, and into the inbox API response.
 *
 * These tests exist so that never comes back.
 */
describe('toPublicActions', () => {
  it('strips the webhook URL', () => {
    const result = toPublicActions([
      { id: 'unlock', label: 'Unlock', url: 'https://ha.local/api/webhook/SECRET' },
    ]);

    expect(result).toEqual([{ id: 'unlock', label: 'Unlock' }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('webhook');
  });

  it('keeps id and label, which are all the client uses', () => {
    expect(
      toPublicActions([{ id: 'silence', label: 'Silence alarm' }]),
    ).toEqual([{ id: 'silence', label: 'Silence alarm' }]);
  });

  it('handles several actions', () => {
    const result = toPublicActions([
      { id: 'a', label: 'A', url: 'https://ha.local/api/webhook/ONE' },
      { id: 'b', label: 'B', url: 'https://ha.local/api/webhook/TWO' },
    ]);
    expect(result).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ONE|TWO/);
  });

  it('passes null through', () => {
    expect(toPublicActions(null)).toBeNull();
    expect(toPublicActions(undefined)).toBeNull();
  });
});

describe('push notification actions', () => {
  it('never carries a webhook URL to the device', () => {
    const payload = withAckAction([
      { id: 'unlock', label: 'Unlock', url: 'https://ha.local/api/webhook/SECRET' },
    ]);

    expect(JSON.stringify(payload)).not.toContain('SECRET');
    expect(payload).toEqual([
      { id: 'ack', label: 'Acknowledge' },
      { id: 'unlock', label: 'Unlock' },
    ]);
  });

  it('still adds an Acknowledge button when the sender supplied none', () => {
    expect(withAckAction(null)).toEqual([{ id: 'ack', label: 'Acknowledge' }]);
  });

  it('does not add a second Acknowledge if the sender already sent one', () => {
    const payload = withAckAction([{ id: 'ack', label: 'Got it' }]);
    expect(payload.filter((a) => a.id === 'ack')).toHaveLength(1);
    expect(payload).toEqual([{ id: 'ack', label: 'Got it' }]);
  });
});
