import { useEffect, useState } from 'react';
import {
  api,
  type EscalationRule,
  type ManagedUser,
  type Topic,
} from '../lib/api.js';

const PRIORITIES = ['low', 'normal', 'high', 'critical'];

/**
 * Admin panel. Escalation chains and user management previously existed only as
 * API endpoints, which made the product's headline feature effectively unusable
 * without curl. This surfaces them.
 */
export function AdminPanel({ onTenantRenamed }: { onTenantRenamed: (n: string) => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  return (
    <div className="space-y-8">
      {error && (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {status && <p className="text-sm text-green-700">{status}</p>}

      <TenantSection
        onSaved={(n) => {
          setStatus(`Renamed to "${n}"`);
          onTenantRenamed(n);
        }}
        onError={report}
      />
      <SmsTestSection onStatus={setStatus} onError={report} />
      <UsersSection onStatus={setStatus} onError={report} />
      <TopicsSection onStatus={setStatus} onError={report} />
      <EscalationSection onStatus={setStatus} onError={report} />
    </div>
  );
}

/* -------------------------------------------------------------- sms test --- */

/**
 * The SMS channel is the only one that can wake a silenced phone, and it can
 * die quietly — a prepaid SIM expires, the WireGuard tunnel drops, the modem
 * wedges. Nothing tells you until the night it matters. So: test it on demand,
 * and re-test it periodically.
 */
function SmsTestSection({
  onStatus,
  onError,
}: {
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await api.testSms(to.trim() || undefined);
      onStatus(`Test SMS sent to ${res.to} via ${res.provider}. Check the phone.`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Test the SMS channel
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        Sends straight through the SMS provider, skipping topics, quiet hours and
        escalation. If this works, the channel is fine and any remaining problem
        is in routing. Worth repeating monthly — a prepaid SIM can expire without
        warning.
      </p>
      <div className="flex gap-2">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="+358401234567 (blank = your own number)"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <button
          onClick={run}
          disabled={busy}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send test'}
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- tenant --- */

function TenantSection({
  onSaved,
  onError,
}: {
  onSaved: (name: string) => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.tenant().then((t) => setName(t.name)).catch(onError);
  }, []);

  async function save() {
    setBusy(true);
    try {
      const t = await api.renameTenant(name);
      onSaved(t.name);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Household name
      </h2>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <button
          onClick={save}
          disabled={busy || !name.trim()}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        The initial value comes from TENANT_NAME in .env; changing it here does
        not require a redeploy.
      </p>
    </section>
  );
}

/* ----------------------------------------------------------------- users --- */

function UsersSection({
  onStatus,
  onError,
}: {
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [sms, setSms] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.users().then(setUsers).catch(onError);
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    try {
      await api.createUser({
        name,
        password,
        role: 'member',
        ...(sms ? { sms_number: sms } : {}),
      });
      setName('');
      setPassword('');
      setSms('');
      onStatus('User created and subscribed to all topics');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Family members
      </h2>
      <ul className="mb-3 space-y-1 text-sm">
        {users.map((u) => (
          <li key={u.id} className="flex justify-between rounded border border-neutral-200 px-2 py-1">
            <span>
              {u.name}{' '}
              <span className="text-xs text-neutral-400">({u.role})</span>
            </span>
            <span className="text-xs text-neutral-500">
              {u.smsNumber ?? 'no SMS number'}
            </span>
          </li>
        ))}
      </ul>

      <div className="space-y-2 rounded border border-neutral-200 p-2">
        <p className="text-xs font-medium text-neutral-600">Add a member</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoCapitalize="none"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min 8 characters)"
          type="password"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <input
          value={sms}
          onChange={(e) => setSms(e.target.value)}
          placeholder="SMS number, e.g. +358401234567 (optional)"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <p className="text-xs text-neutral-500">
          An SMS number is what lets critical alerts break through silent mode.
        </p>
        <button
          onClick={create}
          disabled={busy || !name || password.length < 8}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create member'}
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- topics --- */

function TopicsSection({
  onStatus,
  onError,
}: {
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);

  const load = () => api.topics().then(setTopics).catch(onError);
  useEffect(() => {
    void load();
  }, []);

  async function save(t: Topic, seconds: string) {
    try {
      const value = seconds.trim() === '' ? null : Number(seconds);
      await api.patchTopic(t.id, { dedup_cooldown_seconds: value });
      onStatus(`Cooldown updated for "${t.name}"`);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Deduplication cooldown
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        Repeats of the same <code>dedup_key</code> within this window are folded
        into one notification. Blank = use the server default. A chatty door
        sensor and a leak detector rarely want the same window.
      </p>
      <ul className="space-y-2">
        {topics.map((t) => (
          <TopicCooldownRow key={t.id} topic={t} onSave={save} />
        ))}
      </ul>
    </section>
  );
}

function TopicCooldownRow({
  topic,
  onSave,
}: {
  topic: Topic;
  onSave: (t: Topic, seconds: string) => void;
}) {
  const [value, setValue] = useState(
    topic.dedupCooldownSeconds?.toString() ?? '',
  );
  return (
    <li className="flex items-center gap-2 rounded border border-neutral-200 px-2 py-1">
      <span className="flex-1 text-sm">{topic.name}</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="default"
        inputMode="numeric"
        className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm"
      />
      <span className="text-xs text-neutral-400">sec</span>
      <button
        onClick={() => onSave(topic, value)}
        className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white"
      >
        Save
      </button>
    </li>
  );
}

/* ------------------------------------------------------------ escalation --- */

function EscalationSection({
  onStatus,
  onError,
}: {
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [rules, setRules] = useState<EscalationRule[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);

  const [topicId, setTopicId] = useState<string>('');
  const [minPriority, setMinPriority] = useState('critical');
  const [delay, setDelay] = useState('180');
  const [channel, setChannel] = useState('sms');
  const [userId, setUserId] = useState<string>('');
  const [step, setStep] = useState('1');
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api.escalationRules(), api.topics(), api.users()])
      .then(([r, t, u]) => {
        setRules(r);
        setTopics(t);
        setUsers(u);
      })
      .catch(onError);

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    try {
      await api.createEscalationRule({
        topic_id: topicId || null,
        min_priority: minPriority,
        delay_seconds: Number(delay),
        next_channel: channel || null,
        next_user_id: userId || null,
        step_order: Number(step),
      });
      onStatus('Escalation rule added');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteEscalationRule(id);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  const topicName = (id: string | null) =>
    id ? (topics.find((t) => t.id === id)?.name ?? '?') : 'all topics';
  const userName = (id: string | null) =>
    id ? (users.find((u) => u.id === id)?.name ?? '?') : 'original recipients';

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Escalation chains
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        If nobody acknowledges within the delay, the alert escalates. Any
        acknowledgement cancels the whole chain. Steps run in order.
      </p>

      <ul className="mb-3 space-y-1 text-sm">
        {rules.length === 0 && (
          <li className="text-neutral-500">No rules yet.</li>
        )}
        {rules
          .slice()
          .sort((a, b) => a.stepOrder - b.stepOrder)
          .map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded border border-neutral-200 px-2 py-1"
            >
              <span className="text-xs">
                <strong>Step {r.stepOrder}</strong> · {topicName(r.topicId)} ·{' '}
                {r.minPriority}+ · after {r.delaySeconds}s → {r.nextChannel} to{' '}
                {userName(r.nextUserId)}
              </span>
              <button
                onClick={() => remove(r.id)}
                className="ml-2 text-xs text-red-600"
              >
                Delete
              </button>
            </li>
          ))}
      </ul>

      <div className="space-y-2 rounded border border-neutral-200 p-2">
        <p className="text-xs font-medium text-neutral-600">Add a step</p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">Topic</span>
            <select
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              <option value="">All topics</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">Triggers at</span>
            <select
              value={minPriority}
              onChange={(e) => setMinPriority(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}+
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">Delay (seconds)</span>
            <input
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              inputMode="numeric"
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">Step order</span>
            <input
              value={step}
              onChange={(e) => setStep(e.target.value)}
              inputMode="numeric"
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">Channel</span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              <option value="sms">sms</option>
              <option value="webpush">webpush</option>
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">Escalate to</span>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              <option value="">Original recipients</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          onClick={create}
          disabled={busy}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add step'}
        </button>
      </div>
    </section>
  );
}
