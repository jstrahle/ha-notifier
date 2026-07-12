import type { Priority } from '../lib/priority.js';
import { isCritical } from '../lib/priority.js';
import type { Channel, ChannelPref, Subscriber } from './types.js';

/**
 * Decides which channels a message should go out on for a single subscriber.
 * Pure function — no I/O — so it is exhaustively unit-testable.
 *
 * Rules:
 *  - push_only  => webpush (never SMS)
 *  - sms_only   => sms, but only if SMS is deliverable; otherwise fall back to
 *                  webpush so the user is not silently cut off
 *  - auto       => critical goes to webpush AND sms in parallel;
 *                  everything else goes to webpush only.
 *
 * SMS is only ever selected when a provider is configured AND the user has a
 * number. Selecting it otherwise queues deliveries that can only fail.
 */
export function selectChannels(
  pref: ChannelPref,
  priority: Priority,
  subscriber: Pick<Subscriber, 'smsNumber'>,
  smsEnabled: boolean,
): Channel[] {
  const canSms = smsEnabled && Boolean(subscriber.smsNumber);

  switch (pref) {
    case 'push_only':
      return ['webpush'];
    case 'sms_only':
      // Fall back to push rather than dropping the message entirely.
      return canSms ? ['sms'] : ['webpush'];
    case 'auto':
    default:
      if (isCritical(priority) && canSms) {
        return ['webpush', 'sms'];
      }
      return ['webpush'];
  }
}
