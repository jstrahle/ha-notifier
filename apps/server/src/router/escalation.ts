import { generateToken, tokenExpiry } from '../lib/tokens.js';
import type { RouterConfig } from './router.js';
import type { Clock, Queue, Store } from './types.js';
import { systemClock } from './types.js';

export interface EscalationResult {
  cancelledByAck: boolean;
  escalatedTo: { userId: string; channel: string }[];
  nextStepScheduled: boolean;
}

/**
 * Executes one escalation step. Invoked by the escalation worker after the
 * configured delay.
 *
 * Core invariant: an acknowledgement on ANY delivery of the message cancels the
 * entire chain. We enforce this by checking ack state at the start of every
 * step rather than trying to cancel already-scheduled jobs.
 */
export class EscalationProcessor {
  constructor(
    private readonly store: Store,
    private readonly queue: Queue,
    private readonly config: RouterConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  async run(
    tenantId: string,
    messageId: string,
    topicId: string | null,
    stepOrder: number,
  ): Promise<EscalationResult> {
    // 1. If anyone acknowledged, the chain stops here.
    if (await this.store.isMessageAcknowledged(messageId)) {
      return { cancelledByAck: true, escalatedTo: [], nextStepScheduled: false };
    }

    const rules = await this.store.getEscalationRules(tenantId, topicId);
    const rule = rules.find((r) => r.stepOrder === stepOrder);
    if (!rule) {
      return {
        cancelledByAck: false,
        escalatedTo: [],
        nextStepScheduled: false,
      };
    }

    // 2. Determine targets. next_user_id null => original subscribers.
    const now = this.clock.now();
    const escalatedTo: { userId: string; channel: string }[] = [];
    // If the rule asks for SMS but no provider is configured, escalate over
    // push instead of silently doing nothing.
    const requested = rule.nextChannel ?? 'sms';
    const channel =
      requested === 'sms' && !this.config.smsEnabled ? 'webpush' : requested;

    const targets = rule.nextUserId
      ? [await this.store.getUserById(rule.nextUserId)]
      : await this.store.getSubscribers(tenantId, topicId);

    for (const target of targets) {
      if (!target) continue;
      if (channel === 'sms' && !target.smsNumber) continue;


      const delivery = await this.store.createDelivery({
        messageId,
        userId: target.userId,
        channel,
        ackToken: generateToken(),
        ackTokenExp: tokenExpiry(this.config.ackTokenTtlSeconds, now),
      });
      await this.queue.enqueueDelivery(delivery.id);
      escalatedTo.push({ userId: target.userId, channel });
    }

    // 3. Schedule the next step if one exists.
    const nextStep = rules.find((r) => r.stepOrder === stepOrder + 1);
    let nextStepScheduled = false;
    if (nextStep) {
      await this.queue.scheduleEscalation(
        { messageId, stepOrder: stepOrder + 1 },
        nextStep.delaySeconds,
      );
      nextStepScheduled = true;
    }

    return { cancelledByAck: false, escalatedTo, nextStepScheduled };
  }
}
