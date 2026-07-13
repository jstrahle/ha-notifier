import postgres from 'postgres';
import { loadConfig } from '../config.js';

/**
 * Minimal migration runner. For the MVP we keep a single idempotent DDL script
 * rather than a full migration history; the future commercial branch can adopt
 * drizzle-kit migrations. `CREATE ... IF NOT EXISTS` makes re-runs safe.
 */
const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  sms_number text,
  role text NOT NULL DEFAULT 'member',
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  platform text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  min_priority text NOT NULL DEFAULT 'normal',
  quiet_start time,
  quiet_end time,
  channel_pref text NOT NULL DEFAULT 'auto',
  UNIQUE (user_id, topic_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  topic_id uuid REFERENCES topics(id),
  priority text NOT NULL DEFAULT 'normal',
  title text NOT NULL,
  body text NOT NULL,
  actions jsonb,
  media_url text,
  dedup_key text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  ack_token text UNIQUE,
  ack_token_exp timestamptz,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  error text
);

CREATE TABLE IF NOT EXISTS escalation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  topic_id uuid REFERENCES topics(id),
  min_priority text NOT NULL DEFAULT 'critical',
  delay_seconds int NOT NULL DEFAULT 180,
  next_channel text,
  next_user_id uuid REFERENCES users(id),
  step_order int NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{notify}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  action_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  http_status int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Additive migrations for existing installs. ADD COLUMN IF NOT EXISTS keeps the
-- whole script idempotent, so it is safe to re-run on every deploy.
ALTER TABLE topics    ADD COLUMN IF NOT EXISTS dedup_cooldown_seconds int;
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS duplicate_count int NOT NULL DEFAULT 0;
ALTER TABLE api_keys  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS session_version int NOT NULL DEFAULT 1;

-- Deletion semantics.
--
-- The original DDL declared these foreign keys inline with no ON DELETE action,
-- so deleting a topic or a user that had ever been used failed outright. We
-- rewrite them here.
--
-- Note the constraint names: inline REFERENCES in the original DDL got
-- PostgreSQL's default naming (table_column_fkey), while Drizzle would name the
-- same constraint table_column_reftable_refcol_fk. Depending on how a given
-- installation was created it may have either, so we drop both candidates.
-- Dropping only the wrong name would succeed silently and leave the old
-- constraint in place -- the failure would then surface later, on a delete.
DO $$
BEGIN
  -- Alert history survives its topic; the messages are simply detached.
  ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_topic_id_fkey;
  ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_topic_id_topics_id_fk;
  ALTER TABLE messages
    ADD CONSTRAINT messages_topic_id_fkey
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL;

  -- An escalation rule scoped to a deleted topic is meaningless.
  -- (topic_id NULL = "applies to every topic", and is untouched by this.)
  ALTER TABLE escalation_rules DROP CONSTRAINT IF EXISTS escalation_rules_topic_id_fkey;
  ALTER TABLE escalation_rules DROP CONSTRAINT IF EXISTS escalation_rules_topic_id_topics_id_fk;
  ALTER TABLE escalation_rules
    ADD CONSTRAINT escalation_rules_topic_id_fkey
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE;

  -- A removed person's delivery rows are their inbox; they mean nothing without
  -- them.
  ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_user_id_fkey;
  ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_user_id_users_id_fk;
  ALTER TABLE deliveries
    ADD CONSTRAINT deliveries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

  -- An escalation rule that targeted a deleted person falls back to notifying
  -- the original recipients, rather than vanishing with them.
  ALTER TABLE escalation_rules DROP CONSTRAINT IF EXISTS escalation_rules_next_user_id_fkey;
  ALTER TABLE escalation_rules DROP CONSTRAINT IF EXISTS escalation_rules_next_user_id_users_id_fk;
  ALTER TABLE escalation_rules
    ADD CONSTRAINT escalation_rules_next_user_id_fkey
    FOREIGN KEY (next_user_id) REFERENCES users(id) ON DELETE SET NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_dedup ON messages (tenant_id, dedup_key, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status, channel);
CREATE INDEX IF NOT EXISTS idx_action_events_message ON action_events (message_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
`;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(DDL);
  } finally {
    await sql.end();
  }
}

// Allow `npm run migrate` to invoke this directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  runMigrations(config.DATABASE_URL)
    .then(() => {
      console.log('Migrations applied.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
