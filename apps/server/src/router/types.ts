import type { Priority } from '../lib/priority.js';

export type { Priority };

/**
 * Domain types and "ports" (interfaces) that the router depends on.
 *
 * The router contains the product's core decision logic. By depending only on
 * these interfaces — not on Drizzle or Redis directly — the same logic runs
 * against the real Postgres/Redis adapters in production and against in-memory
 * fakes in tests. This is what lets us validate the full decision flow without
 * live infrastructure.
 */

export type Channel = 'webpush' | 'sms';

/**
 * What an escalation step does.
 *
 * 'action' runs the alert's own escalatable actions — closing the valve nobody
 * came to close — and then reports the outcome, by SMS to the step's recipient
 * and by push to everyone.
 */
export type EscalationChannel = Channel | 'action';
export type ChannelPref = 'auto' | 'push_only' | 'sms_only';
export type DeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'acknowledged';

export interface MessageInput {
  id: string;
  tenantId: string;
  topicId: string | null;
  topicName: string | null;
  priority: Priority;
  title: string;
  body: string;
  dedupKey: string | null;
  actions: NotificationAction[] | null;
  /** Per-topic cooldown override; null falls back to the global default. */
  dedupCooldownSeconds: number | null;
  /**
   * False for messages an escalation produced. Such a message must never arm a
   * chain of its own, or reporting "valve closed" would escalate, run the action
   * again, report again — for ever.
   */
  escalates: boolean;
}

export interface NotificationAction {
  id: string;
  label: string;
  url?: string;
  /**
   * May an escalation run this without a human?
   *
   * Opt-in, per action, per alert, by the sender. The escalation rule says only
   * "run this alert's escalatable actions" — it never names one. So the Home
   * Assistant automation that raises a kitchen-leak alert decides that "close
   * valve" is safe to run unattended, while "call the plumber" on the same alert
   * is not, and a door sensor's alert offers nothing at all.
   *
   * Only ever set this on actions that move things to a SAFE state: closing a
   * valve, cutting power, silencing a siren. Never on unlocking a door.
   */
  escalate?: boolean;
}

export interface Subscriber {
  userId: string;
  smsNumber: string | null;
  minPriority: Priority;
  quietStart: string | null; // "HH:MM"
  quietEnd: string | null;
  channelPref: ChannelPref;
}

export interface EscalationRule {
  id: string;
  topicId: string | null; // null = applies to all topics
  minPriority: Priority;
  delaySeconds: number;
  nextChannel: EscalationChannel | null;
  /**
   * Who this step notifies. For an 'action' step this is who gets told, by SMS,
   * whether the action worked — the person who will have to go and deal with it
   * if it did not.
   */
  nextUserId: string | null; // null = re-notify original recipients
  stepOrder: number;
}

export interface PlannedDelivery {
  userId: string;
  channel: Channel;
}

/** Persistence port. Backed by Drizzle/Postgres in production. */
export interface Store {
  /** Users subscribed to this topic (all priorities; router filters). */
  getSubscribers(tenantId: string, topicId: string | null): Promise<Subscriber[]>;
  getUserById(userId: string): Promise<Subscriber | null>;
  /** Escalation rules for a topic (topic-specific + tenant-wide), ordered. */
  getEscalationRules(
    tenantId: string,
    topicId: string | null,
  ): Promise<EscalationRule[]>;
  createDelivery(input: {
    messageId: string;
    userId: string;
    channel: Channel;
    ackToken: string | null;
    ackTokenExp: Date | null;
  }): Promise<{ id: string }>;
  /** True if ANY delivery for this message has been acknowledged. */
  isMessageAcknowledged(messageId: string): Promise<boolean>;
  /** Bump the aggregation counter for a suppressed duplicate. */
  recordDuplicate(tenantId: string, dedupKey: string): Promise<void>;

  /**
   * The message that suppressed duplicates were folded into, if any are
   * pending. Returns null when nothing was suppressed.
   */
  getAggregationCandidate(
    tenantId: string,
    dedupKey: string,
  ): Promise<{ messageId: string; duplicateCount: number } | null>;

  /** Fold the count into the message body and reset the counter. */
  applyAggregation(messageId: string, duplicateCount: number): Promise<void>;

  /**
   * Web push deliveries for this message that are worth re-sending: not yet
   * acknowledged. SMS is deliberately excluded — re-sending a text for every
   * aggregation window would be both noisy and expensive.
   */
  getResendableDeliveries(messageId: string): Promise<string[]>;

  /** The alert's context and its escalatable actions, for an 'action' step. */
  getMessageForEscalation(messageId: string): Promise<{
    title: string;
    priority: Priority;
    topicName: string | null;
    actions: NotificationAction[];
  } | null>;

  /**
   * Claim the right to run this action automatically, exactly once.
   *
   * Returns false if it has already been claimed — a queue job can be retried,
   * and a retry must not close the valve twice. Backed by a unique index, so the
   * guarantee holds even against two workers racing.
   */
  claimEscalationAction(messageId: string, actionId: string): Promise<boolean>;

  /** Record how the automatic invocation went. */
  recordEscalationActionResult(
    messageId: string,
    actionId: string,
    result: { ok: boolean; httpStatus: number | null; error: string | null },
  ): Promise<void>;

  /** A message the system raised itself. Never escalates — see MessageInput. */
  createSystemMessage(input: {
    tenantId: string;
    topicId: string | null;
    priority: Priority;
    title: string;
    body: string;
  }): Promise<{ id: string }>;
}

/**
 * Calls an action's webhook. A port, so the escalation logic can be tested
 * without a network — the decision of *whether* to close the valve is the part
 * that must be provably correct.
 */
export interface ActionInvoker {
  invoke(
    action: NotificationAction,
    context: { messageId: string; title: string; priority: string; topic: string | null },
  ): Promise<{ ok: boolean; httpStatus: number | null; error: string | null }>;
}

/** Deduplication cooldown port. Backed by Redis in production. */
export interface DedupStore {
  /**
   * Atomically checks and sets a cooldown for (tenant, dedupKey). Returns true
   * if a cooldown was already active (=> this message is a duplicate and
   * should be suppressed), false if this is the first occurrence.
   */
  checkAndSet(
    tenantId: string,
    dedupKey: string,
    ttlSeconds: number,
  ): Promise<boolean>;
}

/** Job queue port. Backed by BullMQ/Redis in production. */
export interface Queue {
  enqueueDelivery(deliveryId: string): Promise<void>;
  scheduleEscalation(
    payload: { messageId: string; stepOrder: number },
    delaySeconds: number,
  ): Promise<void>;
  /** Fires when the dedup cooldown expires, to flush the aggregated summary. */
  scheduleAggregation(
    payload: { tenantId: string; dedupKey: string },
    delaySeconds: number,
  ): Promise<void>;
}

/** Clock port, so tests can control "now". */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
