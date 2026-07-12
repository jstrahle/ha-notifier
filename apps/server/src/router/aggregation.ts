import type { Queue, Store } from './types.js';

export interface AggregationResult {
  flushed: boolean;
  duplicateCount: number;
  resentDeliveries: number;
}

/**
 * Aggregation flush.
 *
 * Deduplication alone only suppresses noise — the user never learns that the
 * sensor fired another six times. This processor closes that gap. It runs when
 * the dedup cooldown for a key expires and, if any duplicates were swallowed,
 * folds them into the original message and re-sends it.
 *
 * Two deliberate choices:
 *  - We update and re-send the *original* message rather than creating a new
 *    one. The push carries the same `tag`, so the browser replaces the existing
 *    notification in place instead of stacking a second one, and the Inbox keeps
 *    a single entry rather than sprouting a duplicate row.
 *  - Only web push deliveries are re-sent. Re-sending an SMS for every
 *    aggregation window would be noisy and would cost real money per message.
 */
export class AggregationProcessor {
  constructor(
    private readonly store: Store,
    private readonly queue: Queue,
  ) {}

  async run(tenantId: string, dedupKey: string): Promise<AggregationResult> {
    const candidate = await this.store.getAggregationCandidate(
      tenantId,
      dedupKey,
    );

    // Nothing was suppressed during the window: the first notification already
    // told the whole story, so stay quiet.
    if (!candidate || candidate.duplicateCount === 0) {
      return { flushed: false, duplicateCount: 0, resentDeliveries: 0 };
    }

    await this.store.applyAggregation(
      candidate.messageId,
      candidate.duplicateCount,
    );

    const deliveryIds = await this.store.getResendableDeliveries(
      candidate.messageId,
    );
    for (const id of deliveryIds) {
      await this.queue.enqueueDelivery(id);
    }

    return {
      flushed: true,
      duplicateCount: candidate.duplicateCount,
      resentDeliveries: deliveryIds.length,
    };
  }
}

/** The summary line appended to an aggregated message body. */
export function summarize(body: string, duplicateCount: number): string {
  const times = duplicateCount === 1 ? 'once' : `${duplicateCount} times`;
  const note = `Repeated ${times} while muted.`;
  return body ? `${body}\n\n${note}` : note;
}
