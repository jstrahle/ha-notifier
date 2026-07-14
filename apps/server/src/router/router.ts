import { priorityAtLeast, isCritical } from '../lib/priority.js';
import { isInQuietHours } from '../lib/timewindow.js';
import { generateToken, tokenExpiry } from '../lib/tokens.js';
import { selectChannels } from './channels.js';
import type {
  Clock,
  DedupStore,
  MessageInput,
  PlannedDelivery,
  Queue,
  Store,
} from './types.js';
import { systemClock } from './types.js';

export interface RouterConfig {
  /** Cooldown applied to a dedup_key before a fresh notification is allowed. */
  dedupCooldownSeconds: number;
  /** TTL for single-use acknowledgement tokens. */
  ackTokenTtlSeconds: number;
  /** Whether an SMS provider is actually configured and able to deliver. */
  smsEnabled: boolean;
}

export interface RouteResult {
  suppressedAsDuplicate: boolean;
  plannedDeliveries: PlannedDelivery[];
  escalationScheduled: boolean;
  aggregationScheduled: boolean;
}

/**
 * The Notification Router: the product's core decision engine.
 *
 * Given a stored message, it decides whether to suppress it as a duplicate,
 * which subscribers should receive it, on which channels, and whether to arm
 * an escalation timer. It writes delivery rows and enqueues work through the
 * injected ports, so the whole flow is testable in memory.
 */
export class Router {
  constructor(
    private readonly store: Store,
    private readonly dedup: DedupStore,
    private readonly queue: Queue,
    private readonly config: RouterConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  async route(message: MessageInput): Promise<RouteResult> {
    const critical = isCritical(message.priority);

    // A topic may override the global cooldown: a chatty door sensor and a leak
    // detector do not want the same window.
    const cooldownSeconds =
      message.dedupCooldownSeconds ?? this.config.dedupCooldownSeconds;

    let aggregationScheduled = false;

    // 1. Deduplication / aggregation. Critical messages are never suppressed.
    if (message.dedupKey && !critical) {
      const onCooldown = await this.dedup.checkAndSet(
        message.tenantId,
        message.dedupKey,
        cooldownSeconds,
      );
      if (onCooldown) {
        // Suppressed — but counted, so the aggregation flush can tell the user
        // it happened rather than silently swallowing it.
        await this.store.recordDuplicate(message.tenantId, message.dedupKey);
        return {
          suppressedAsDuplicate: true,
          plannedDeliveries: [],
          escalationScheduled: false,
          aggregationScheduled: false,
        };
      }

      // First occurrence: arm the flush that will report any duplicates
      // swallowed during this window.
      await this.queue.scheduleAggregation(
        { tenantId: message.tenantId, dedupKey: message.dedupKey },
        cooldownSeconds,
      );
      aggregationScheduled = true;
    }

    // 2. Recipient selection: subscribers whose min_priority allows this message.
    const subscribers = await this.store.getSubscribers(
      message.tenantId,
      message.topicId,
    );
    const eligible = subscribers.filter((s) =>
      priorityAtLeast(message.priority, s.minPriority),
    );

    const now = this.clock.now();
    const planned: PlannedDelivery[] = [];

    // 3. Per recipient: quiet-hours check, then channel selection.
    for (const sub of eligible) {
      if (
        !critical &&
        isInQuietHours({ start: sub.quietStart, end: sub.quietEnd }, now)
      ) {
        continue; // suppressed during quiet hours (non-critical only)
      }

      const channels = selectChannels(
        sub.channelPref,
        message.priority,
        sub,
        this.config.smsEnabled,
      );
      for (const channel of channels) {
        // Every delivery gets an ack token, not just SMS. The token is what the
        // service worker uses to acknowledge straight from a notification
        // button, so acknowledgement keeps working even if the browser session
        // has expired.
        const delivery = await this.store.createDelivery({
          messageId: message.id,
          userId: sub.userId,
          channel,
          ackToken: generateToken(),
          ackTokenExp: tokenExpiry(this.config.ackTokenTtlSeconds, now),
        });
        await this.queue.enqueueDelivery(delivery.id);
        planned.push({ userId: sub.userId, channel });
      }
    }

    // 4. Escalation scheduling.
    const escalationScheduled = await this.maybeScheduleEscalation(message);

    return {
      suppressedAsDuplicate: false,
      plannedDeliveries: planned,
      escalationScheduled,
      aggregationScheduled,
    };
  }

  private async maybeScheduleEscalation(
    message: MessageInput,
  ): Promise<boolean> {
    // The loop guard. A message the escalation produced ("valve closed
    // automatically") must never arm a chain of its own: it would run the action
    // again, report again, escalate again — closing and reopening a valve for
    // ever. Enforced here, at the single point where any chain can start.
    if (!message.escalates) return false;

    const rules = await this.store.getEscalationRules(
      message.tenantId,
      message.topicId,
    );
    const firstStep = rules
      .filter(
        (r) =>
          r.stepOrder === 1 && priorityAtLeast(message.priority, r.minPriority),
      )
      .sort((a, b) => a.delaySeconds - b.delaySeconds)[0];

    if (!firstStep) return false;

    await this.queue.scheduleEscalation(
      { messageId: message.id, stepOrder: 1 },
      firstStep.delaySeconds,
    );
    return true;
  }
}
