import {
  pgTable,
  uuid,
  text,
  timestamp,
  time,
  integer,
  jsonb,
  boolean,
  unique,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Database schema (Drizzle). Mirrors the SQL in the implementation spec.
 * `tenantId` is present on every table from day one so the future multi-tenant
 * branch needs no migration; the MVP simply pins it to a single tenant.
 */

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  smsNumber: text('sms_number'),
  role: text('role').notNull().default('member'), // 'admin' | 'member'
  passwordHash: text('password_hash'),
  /**
   * Bumping this invalidates every session cookie the user holds. Used by
   * "log out all devices" and by password changes.
   */
  sessionVersion: integer('session_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  platform: text('platform'), // 'ios' | 'android' | 'desktop'
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** Per-topic dedup cooldown. NULL falls back to DEDUP_COOLDOWN_SECONDS. */
    dedupCooldownSeconds: integer('dedup_cooldown_seconds'),
  },
  (t) => ({ uniqName: unique().on(t.tenantId, t.name) }),
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    minPriority: text('min_priority').notNull().default('normal'),
    quietStart: time('quiet_start'),
    quietEnd: time('quiet_end'),
    channelPref: text('channel_pref').notNull().default('auto'),
  },
  (t) => ({ uniqUserTopic: unique().on(t.userId, t.topicId) }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Deleting a topic must not destroy the alert history: the messages stay,
    // detached from the (now gone) topic.
    topicId: uuid('topic_id').references(() => topics.id, {
      onDelete: 'set null',
    }),
    priority: text('priority').notNull().default('normal'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    actions: jsonb('actions'),
    mediaUrl: text('media_url'),
    dedupKey: text('dedup_key'),
    /** How many duplicates were suppressed and folded into this message. */
    duplicateCount: integer('duplicate_count').notNull().default(0),
    /**
     * Whether this message may start an escalation chain.
     *
     * False for the notifications an escalation itself produces ("valve closed
     * automatically"). Without this they would be routed like any other alert,
     * arm their own chain, run the action again, produce another notification —
     * a loop that opens and closes a valve forever.
     */
    escalates: boolean('escalates').notNull().default(true),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupIdx: index('idx_messages_dedup').on(t.tenantId, t.dedupKey, t.createdAt),
  }),
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(), // 'webpush' | 'sms'
    status: text('status').notNull().default('queued'),
    ackToken: text('ack_token').unique(),
    ackTokenExp: timestamp('ack_token_exp', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => ({ statusIdx: index('idx_deliveries_status').on(t.status, t.channel) }),
);

export const escalationRules = pgTable('escalation_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  // A rule scoped to a deleted topic has no meaning; drop it with the topic.
  // (topic_id NULL = applies to every topic, and is unaffected.)
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }),
  minPriority: text('min_priority').notNull().default('critical'),
  delaySeconds: integer('delay_seconds').notNull().default(180),
  nextChannel: text('next_channel'),
  // If the escalation target is deleted, the rule falls back to re-notifying the
  // original recipients rather than disappearing silently.
  nextUserId: uuid('next_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  stepOrder: integer('step_order').notNull().default(1),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** Owner. NULL = tenant-level key (e.g. the one created by the seed). */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').array().notNull().default(['notify']),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/** Audit trail for action-button presses and their outbound webhooks. */
export const actionEvents = pgTable('action_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  actionId: text('action_id').notNull(),
  /** NULL when the escalation ran the action rather than a person. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** 'user' | 'escalation' — the receiving system may want to treat them differently. */
  triggeredBy: text('triggered_by').notNull().default('user'),
  status: text('status').notNull().default('pending'), // pending|ok|failed|no_url
  httpStatus: integer('http_status'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
