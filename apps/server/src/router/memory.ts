import { summarize } from './aggregation.js';
import type {
  ActionInvoker,
  Channel,
  Clock,
  DedupStore,
  EscalationRule,
  NotificationAction,
  Priority,
  Queue,
  Store,
  Subscriber,
} from './types.js';

/**
 * In-memory fakes of the router ports. These let us exercise the full routing
 * and escalation flow deterministically in tests, without Postgres or Redis.
 * They also mirror the semantics the real adapters must implement.
 */

interface DeliveryRow {
  id: string;
  messageId: string;
  userId: string;
  channel: Channel;
  ackToken: string | null;
  acknowledged: boolean;
}

interface MessageRow {
  id: string;
  dedupKey: string | null;
  body: string;
  duplicateCount: number;
  createdAt: number;
  title: string;
  priority: Priority;
  topicName: string | null;
  actions: NotificationAction[];
  escalates: boolean;
}

export class MemoryStore implements Store {
  private subscribersByTopic = new Map<string, Subscriber[]>();
  private users = new Map<string, Subscriber>();
  private rules: EscalationRule[] = [];
  deliveries: DeliveryRow[] = [];
  messages: MessageRow[] = [];
  duplicateCounts = new Map<string, number>();
  private seq = 0;

  /** Actions this store was asked to claim, in order. */
  claimedActions: string[] = [];
  /** Messages the system raised itself (e.g. "valve closed"). */
  systemMessages: MessageRow[] = [];

  /** Test helper: register a message so aggregation has something to fold into. */
  addMessage(
    id: string,
    dedupKey: string | null,
    body = 'Body',
    createdAt = Date.now(),
    extra: Partial<MessageRow> = {},
  ): void {
    this.messages.push({
      id,
      dedupKey,
      body,
      duplicateCount: 0,
      createdAt,
      title: 'Alert',
      priority: 'critical',
      topicName: 'security',
      actions: [],
      escalates: true,
      ...extra,
    });
  }

  getMessage(id: string): MessageRow | undefined {
    return this.messages.find((m) => m.id === id);
  }

  private key(tenantId: string, topicId: string | null): string {
    return `${tenantId}::${topicId ?? '*'}`;
  }

  setSubscribers(
    tenantId: string,
    topicId: string | null,
    subs: Subscriber[],
  ): void {
    this.subscribersByTopic.set(this.key(tenantId, topicId), subs);
    for (const s of subs) this.users.set(s.userId, s);
  }

  setEscalationRules(rules: EscalationRule[]): void {
    this.rules = rules;
  }

  async getSubscribers(
    tenantId: string,
    topicId: string | null,
  ): Promise<Subscriber[]> {
    return this.subscribersByTopic.get(this.key(tenantId, topicId)) ?? [];
  }

  async getUserById(userId: string): Promise<Subscriber | null> {
    return this.users.get(userId) ?? null;
  }

  async getEscalationRules(
    _tenantId: string,
    topicId: string | null,
  ): Promise<EscalationRule[]> {
    // Topic-specific rules plus tenant-wide (topicId null) rules.
    return this.rules
      .filter((r) => r.topicId === topicId || r.topicId === null)
      .sort((a, b) => a.stepOrder - b.stepOrder);
  }

  async createDelivery(input: {
    messageId: string;
    userId: string;
    channel: Channel;
    ackToken: string | null;
    ackTokenExp: Date | null;
  }): Promise<{ id: string }> {
    const id = `d${++this.seq}`;
    this.deliveries.push({
      id,
      messageId: input.messageId,
      userId: input.userId,
      channel: input.channel,
      ackToken: input.ackToken,
      acknowledged: false,
    });
    return { id };
  }

  async isMessageAcknowledged(messageId: string): Promise<boolean> {
    return this.deliveries.some(
      (d) => d.messageId === messageId && d.acknowledged,
    );
  }

  async recordDuplicate(tenantId: string, dedupKey: string): Promise<void> {
    const k = `${tenantId}::${dedupKey}`;
    this.duplicateCounts.set(k, (this.duplicateCounts.get(k) ?? 0) + 1);
    const target = this.latestForDedupKey(dedupKey);
    if (target) target.duplicateCount += 1;
  }

  async getAggregationCandidate(
    _tenantId: string,
    dedupKey: string,
  ): Promise<{ messageId: string; duplicateCount: number } | null> {
    const m = this.latestForDedupKey(dedupKey);
    if (!m) return null;
    return { messageId: m.id, duplicateCount: m.duplicateCount };
  }

  async applyAggregation(
    messageId: string,
    duplicateCount: number,
  ): Promise<void> {
    const m = this.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.body = summarize(m.body, duplicateCount);
    m.duplicateCount = 0;
  }

  async getResendableDeliveries(messageId: string): Promise<string[]> {
    return this.deliveries
      .filter(
        (d) =>
          d.messageId === messageId &&
          d.channel === 'webpush' &&
          !d.acknowledged,
      )
      .map((d) => d.id);
  }

  async getMessageForEscalation(messageId: string) {
    const m = this.messages.find((x) => x.id === messageId);
    if (!m) return null;
    return {
      title: m.title,
      priority: m.priority,
      topicName: m.topicName,
      actions: m.actions,
    };
  }

  async claimEscalationAction(messageId: string, actionId: string): Promise<boolean> {
    const key = `${messageId}::${actionId}`;
    if (this.claimedActions.includes(key)) return false; // already run
    this.claimedActions.push(key);
    return true;
  }

  async recordEscalationActionResult(): Promise<void> {
    /* results are asserted through the invoker in tests */
  }

  async createSystemMessage(input: {
    tenantId: string;
    topicId: string | null;
    priority: Priority;
    title: string;
    body: string;
  }): Promise<{ id: string }> {
    const id = `sys${this.systemMessages.length + 1}`;
    const row: MessageRow = {
      id,
      dedupKey: null,
      body: input.body,
      duplicateCount: 0,
      createdAt: Date.now(),
      title: input.title,
      priority: input.priority,
      topicName: null,
      actions: [],
      escalates: false, // the loop guard
    };
    this.systemMessages.push(row);
    this.messages.push(row);
    return { id };
  }

  private latestForDedupKey(dedupKey: string): MessageRow | undefined {
    return this.messages
      .filter((m) => m.dedupKey === dedupKey)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Test helper: mark a delivery acknowledged. */
  acknowledge(deliveryId: string): void {
    const d = this.deliveries.find((x) => x.id === deliveryId);
    if (d) d.acknowledged = true;
  }
}

export class MemoryDedupStore implements DedupStore {
  private active = new Map<string, number>(); // key -> expiry epoch ms
  constructor(private clock: Clock) {}

  async checkAndSet(
    tenantId: string,
    dedupKey: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = `${tenantId}::${dedupKey}`;
    const now = this.clock.now().getTime();
    const exp = this.active.get(key);
    if (exp && exp > now) {
      return true; // still on cooldown => duplicate
    }
    this.active.set(key, now + ttlSeconds * 1000);
    return false;
  }
}

export interface RecordedEscalation {
  messageId: string;
  stepOrder: number;
  delaySeconds: number;
}

export interface RecordedAggregation {
  tenantId: string;
  dedupKey: string;
  delaySeconds: number;
}

export class MemoryQueue implements Queue {
  enqueuedDeliveries: string[] = [];
  scheduledEscalations: RecordedEscalation[] = [];
  scheduledAggregations: RecordedAggregation[] = [];

  async enqueueDelivery(deliveryId: string): Promise<void> {
    this.enqueuedDeliveries.push(deliveryId);
  }

  async scheduleEscalation(
    payload: { messageId: string; stepOrder: number },
    delaySeconds: number,
  ): Promise<void> {
    this.scheduledEscalations.push({ ...payload, delaySeconds });
  }

  async scheduleAggregation(
    payload: { tenantId: string; dedupKey: string },
    delaySeconds: number,
  ): Promise<void> {
    this.scheduledAggregations.push({ ...payload, delaySeconds });
  }
}

/** Records invocations instead of making network calls. */
export class MemoryActionInvoker implements ActionInvoker {
  invoked: { actionId: string; url: string | undefined }[] = [];
  /** Set to make the next invocations fail, as a real webhook would. */
  failWith: string | null = null;

  async invoke(action: NotificationAction) {
    this.invoked.push({ actionId: action.id, url: action.url });
    if (this.failWith) {
      return { ok: false, httpStatus: 500, error: this.failWith };
    }
    return { ok: true, httpStatus: 200, error: null };
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
  advanceSeconds(s: number): void {
    this.current = new Date(this.current.getTime() + s * 1000);
  }
}
