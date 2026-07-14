import { generateToken, tokenExpiry } from '../lib/tokens.js';
import type { RouterConfig } from './router.js';
import type {
  ActionInvoker,
  Channel,
  Clock,
  NotificationAction,
  Queue,
  Store,
} from './types.js';
import { systemClock } from './types.js';

export interface ActionOutcome {
  actionId: string;
  label: string;
  ok: boolean;
  error: string | null;
  /** False when the action had already been run — a retried job, not a failure. */
  ran: boolean;
}

export interface EscalationResult {
  cancelledByAck: boolean;
  escalatedTo: { userId: string; channel: string }[];
  actionsRun: ActionOutcome[];
  nextStepScheduled: boolean;
}

/**
 * Executes one escalation step.
 *
 * Core invariant: an acknowledgement on ANY delivery of the message cancels the
 * entire chain. We enforce it by checking ack state at the start of every step
 * rather than trying to cancel already-scheduled jobs. For an action step this
 * is also the safety mechanism — if a human dealt with the leak, the valve is
 * not closed behind their back.
 */
export class EscalationProcessor {
  constructor(
    private readonly store: Store,
    private readonly queue: Queue,
    private readonly config: RouterConfig,
    private readonly invoker: ActionInvoker,
    private readonly clock: Clock = systemClock,
  ) {}

  async run(
    tenantId: string,
    messageId: string,
    topicId: string | null,
    stepOrder: number,
  ): Promise<EscalationResult> {
    const empty: EscalationResult = {
      cancelledByAck: false,
      escalatedTo: [],
      actionsRun: [],
      nextStepScheduled: false,
    };

    // 1. If anyone acknowledged, the chain stops here — including any action.
    if (await this.store.isMessageAcknowledged(messageId)) {
      return { ...empty, cancelledByAck: true };
    }

    const rules = await this.store.getEscalationRules(tenantId, topicId);
    const rule = rules.find((r) => r.stepOrder === stepOrder);
    if (!rule) return empty;

    const requested = rule.nextChannel ?? 'sms';

    let actionsRun: ActionOutcome[] = [];
    let escalatedTo: { userId: string; channel: string }[] = [];

    if (requested === 'action') {
      actionsRun = await this.runActions(messageId);
      // Tell people what the system just did. This is not optional: someone who
      // comes home to find the water off, with no explanation, stops trusting
      // the system — and trust is the only reason anyone gets up at 3am for it.
      escalatedTo = await this.reportOutcome(
        tenantId,
        topicId,
        messageId,
        rule.nextUserId,
        actionsRun,
      );
    } else {
      escalatedTo = await this.notify(tenantId, topicId, messageId, requested, rule.nextUserId);
    }

    // 3. Schedule the next step, if the chain continues.
    const nextStep = rules.find((r) => r.stepOrder === stepOrder + 1);
    let nextStepScheduled = false;
    if (nextStep) {
      await this.queue.scheduleEscalation(
        { messageId, stepOrder: stepOrder + 1 },
        nextStep.delaySeconds,
      );
      nextStepScheduled = true;
    }

    return { cancelledByAck: false, escalatedTo, actionsRun, nextStepScheduled };
  }

  /** Runs every action the sender marked escalatable on this specific alert. */
  private async runActions(messageId: string): Promise<ActionOutcome[]> {
    const message = await this.store.getMessageForEscalation(messageId);
    if (!message) return [];

    const escalatable = message.actions.filter((a) => a.escalate === true && a.url);
    const outcomes: ActionOutcome[] = [];

    for (const action of escalatable) {
      // Claim it first. A queue job can be retried, and a retry must not close
      // the valve a second time.
      const claimed = await this.store.claimEscalationAction(messageId, action.id);
      if (!claimed) {
        outcomes.push({
          actionId: action.id,
          label: action.label,
          ok: true,
          error: null,
          ran: false, // already done on an earlier attempt
        });
        continue;
      }

      const result = await this.invoker.invoke(action, {
        messageId,
        title: message.title,
        priority: message.priority,
        topic: message.topicName,
      });

      await this.store.recordEscalationActionResult(messageId, action.id, result);

      outcomes.push({
        actionId: action.id,
        label: action.label,
        ok: result.ok,
        error: result.error,
        ran: true,
      });
    }

    return outcomes;
  }

  /**
   * Reports what the automatic action did: SMS to the step's recipient, push to
   * everyone subscribed. A failure is raised as critical — a valve that did not
   * close is worse than one nobody tried to close, because now you think it is
   * handled.
   */
  private async reportOutcome(
    tenantId: string,
    topicId: string | null,
    messageId: string,
    reportToUserId: string | null,
    outcomes: ActionOutcome[],
  ): Promise<{ userId: string; channel: string }[]> {
    if (outcomes.length === 0) return [];

    const original = await this.store.getMessageForEscalation(messageId);
    const alert = original?.title ?? 'an alert';
    const failed = outcomes.filter((o) => !o.ok);
    const ok = outcomes.filter((o) => o.ok && o.ran);

    const title =
      failed.length > 0 ? 'Automatic action FAILED' : 'Automatic action taken';

    const parts: string[] = [];
    if (ok.length > 0) {
      parts.push(
        `${ok.map((o) => o.label).join(', ')} ran automatically because nobody acknowledged "${alert}".`,
      );
    }
    if (failed.length > 0) {
      parts.push(
        `${failed.map((o) => `${o.label} FAILED (${o.error ?? 'unknown error'})`).join('; ')}. Nobody acknowledged "${alert}". Deal with it yourself.`,
      );
    }

    const report = await this.store.createSystemMessage({
      tenantId,
      topicId,
      priority: failed.length > 0 ? 'critical' : 'high',
      title,
      body: parts.join(' '),
    });

    const now = this.clock.now();
    const sent: { userId: string; channel: string }[] = [];

    // Push to everyone subscribed: the household must know the system acted.
    for (const sub of await this.store.getSubscribers(tenantId, topicId)) {
      const d = await this.store.createDelivery({
        messageId: report.id,
        userId: sub.userId,
        channel: 'webpush',
        ackToken: generateToken(),
        ackTokenExp: tokenExpiry(this.config.ackTokenTtlSeconds, now),
      });
      await this.queue.enqueueDelivery(d.id);
      sent.push({ userId: sub.userId, channel: 'webpush' });
    }

    // SMS to the person this step names — the one who has to act if it failed.
    if (reportToUserId && this.config.smsEnabled) {
      const target = await this.store.getUserById(reportToUserId);
      if (target?.smsNumber) {
        const d = await this.store.createDelivery({
          messageId: report.id,
          userId: target.userId,
          channel: 'sms',
          ackToken: generateToken(),
          ackTokenExp: tokenExpiry(this.config.ackTokenTtlSeconds, now),
        });
        await this.queue.enqueueDelivery(d.id);
        sent.push({ userId: target.userId, channel: 'sms' });
      }
    }

    return sent;
  }

  /** An ordinary escalation step: tell another person, on another channel. */
  private async notify(
    tenantId: string,
    topicId: string | null,
    messageId: string,
    requested: Channel,
    nextUserId: string | null,
  ): Promise<{ userId: string; channel: string }[]> {
    // If the rule asks for SMS but no provider is configured, escalate over push
    // rather than silently doing nothing.
    const channel: Channel =
      requested === 'sms' && !this.config.smsEnabled ? 'webpush' : requested;

    const now = this.clock.now();
    const sent: { userId: string; channel: string }[] = [];

    const targets = nextUserId
      ? [await this.store.getUserById(nextUserId)]
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
      sent.push({ userId: target.userId, channel });
    }

    return sent;
  }
}

/** Exported for the report text used in tests and docs. */
export type { NotificationAction };
