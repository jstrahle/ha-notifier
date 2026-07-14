import { useEffect, useState } from 'react';
import {
  api,
  type EscalationRule,
  type ManagedUser,
  type Topic,
} from '../lib/api.js';

const PRIORITIES = ['low', 'normal', 'high', 'critical'];

export function AdminPanel({
  onTenantRenamed,
  currentUserId,
}: {
  onTenantRenamed: (n: string) => void;
  currentUserId: string;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  const say = (s: string) => {
    setError(null);
    setStatus(s);
  };

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
          say(`Renamed to "${n}"`);
          onTenantRenamed(n);
        }}
        onError={report}
      />
      <SmsTestSection onStatus={say} onError={report} />
      <UsersSection currentUserId={currentUserId} onStatus={say} onError={report} />
      <TopicsSection onStatus={say} onError={report} />
      <EscalationSection onStatus={say} onError={report} />
    </div>
  );
}

/* -------------------------------------------------------------- sms test --- */

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
        Sends straight through the provider, skipping topics, quiet hours and
        escalation — so a failure points at the SMS setup and nothing else. Worth
        repeating monthly: a prepaid SIM can expire without warning.
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
    </section>
  );
}

/* ----------------------------------------------------------------- users --- */

function UsersSection({
  currentUserId,
  onStatus,
  onError,
}: {
  currentUserId: string;
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [adding, setAdding] = useState(false);
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
      setAdding(false);
      onStatus('Member added and subscribed to all topics');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  const adminCount = users.filter((u) => u.role === 'admin').length;

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Family members
      </h2>

      <ul className="space-y-2">
        {users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={u.id === currentUserId}
            adminCount={adminCount}
            onSaved={async (msg) => {
              onStatus(msg);
              await load();
            }}
            onError={onError}
          />
        ))}
      </ul>

      {!adding ? (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 w-full rounded border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-600"
        >
          + Add a member
        </button>
      ) : (
        <div className="mt-3 space-y-2 rounded border border-neutral-200 p-2">
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
            placeholder="+358401234567 (optional, but needed for critical alerts)"
            inputMode="tel"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={create}
              disabled={busy || !name || password.length < 8}
              className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button
              onClick={() => setAdding(false)}
              className="px-3 py-1 text-sm text-neutral-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function UserRow({
  user,
  isSelf,
  adminCount,
  onSaved,
  onError,
}: {
  user: ManagedUser;
  isSelf: boolean;
  adminCount: number;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sms, setSms] = useState(user.smsNumber ?? '');
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // You cannot delete yourself, and the last admin cannot be removed or demoted
  // — that would leave the household with nobody able to administer it.
  const isLastAdmin = user.role === 'admin' && adminCount <= 1;
  const canDelete = !isSelf && !isLastAdmin;

  async function save() {
    setBusy(true);
    try {
      const body: { sms_number?: string | null; role?: string; password?: string } = {};
      if ((user.smsNumber ?? '') !== sms.trim()) {
        body.sms_number = sms.trim() === '' ? null : sms.trim();
      }
      if (role !== user.role) body.role = role;
      if (password.length >= 8) body.password = password;

      if (Object.keys(body).length === 0) {
        setOpen(false);
        return;
      }
      await api.patchUser(user.id, body);
      setPassword('');
      setOpen(false);
      await onSaved(`Updated ${user.name}`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !confirm(
        `Delete ${user.name}?\n\nTheir alert history, devices and API keys go with them. This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.deleteUser(user.id);
      await onSaved(`Deleted ${user.name}`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded border border-neutral-200 px-2 py-1">
      <div className="flex items-center justify-between">
        <span className="text-sm">
          {user.name}{' '}
          <span className="text-xs text-neutral-400">({user.role})</span>
          {isSelf && <span className="ml-1 text-xs text-indigo-600">you</span>}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={`text-xs ${user.smsNumber ? 'text-neutral-500' : 'text-amber-700'}`}
          >
            {user.smsNumber ?? 'no SMS number'}
          </span>
          <button
            onClick={() => setOpen(!open)}
            className="text-xs font-medium text-indigo-700"
          >
            {open ? 'Close' : 'Edit'}
          </button>
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-2 border-t border-neutral-100 pt-2">
          <label className="block">
            <span className="text-xs text-neutral-500">SMS number</span>
            <input
              value={sms}
              onChange={(e) => setSms(e.target.value)}
              placeholder="+358401234567"
              inputMode="tel"
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-neutral-500">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={isLastAdmin}
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm disabled:opacity-50"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            {isLastAdmin && (
              <span className="text-xs text-neutral-400">
                The last admin cannot be demoted.
              </span>
            )}
          </label>
          <label className="block">
            <span className="text-xs text-neutral-500">
              Reset password (blank = unchanged)
            </span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="At least 8 characters"
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>

          <div className="flex items-center justify-between">
            <button
              onClick={save}
              disabled={busy}
              className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {canDelete && (
              <button
                onClick={remove}
                disabled={busy}
                className="text-xs text-red-600 disabled:opacity-50"
              >
                Delete member
              </button>
            )}
          </div>
        </div>
      )}
    </li>
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
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.topics().then(setTopics).catch(onError);
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    try {
      await api.createTopic(name.trim());
      setName('');
      onStatus('Topic created, and everyone subscribed to it');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: Topic) {
    if (
      !confirm(
        `Delete topic "${t.name}"?\n\nIts subscriptions and escalation rules are removed. Past alerts are kept.\n\nAnything still sending to "${t.name}" will silently recreate it.`,
      )
    )
      return;
    try {
      await api.deleteTopic(t.id);
      onStatus(`Deleted "${t.name}"`);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  async function saveCooldown(t: Topic, seconds: string) {
    try {
      const value = seconds.trim() === '' ? null : Number(seconds);
      await api.patchTopic(t.id, { dedup_cooldown_seconds: value });
      onStatus(`Cooldown updated for "${t.name}"`);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  const nameIsValid = /^[a-z0-9_-]+$/.test(name.trim());

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Topics
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        Senders address topics by name. A topic is also created automatically the
        first time something posts to a name that does not exist yet.
      </p>
      <p className="mb-3 rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
        <strong>Topics cannot be renamed</strong>, deliberately. Your automations
        post to a <em>name</em>: rename a topic and they would keep posting the
        old one, silently recreating a topic that nobody is subscribed to — and
        the alerts would vanish with no error anywhere. Delete and recreate
        instead, then update the sender.
      </p>

      <ul className="space-y-2">
        {topics.map((t) => (
          <TopicRow
            key={t.id}
            topic={t}
            onSaveCooldown={saveCooldown}
            onDelete={remove}
          />
        ))}
      </ul>

      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="new-topic-name"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <button
          onClick={create}
          disabled={busy || !nameIsValid}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Add topic'}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-400">
        Lowercase letters, digits, <code>-</code> and <code>_</code> only.
      </p>
    </section>
  );
}

function TopicRow({
  topic,
  onSaveCooldown,
  onDelete,
}: {
  topic: Topic;
  onSaveCooldown: (t: Topic, seconds: string) => void;
  onDelete: (t: Topic) => void;
}) {
  const [value, setValue] = useState(
    topic.dedupCooldownSeconds?.toString() ?? '',
  );
  return (
    <li className="rounded border border-neutral-200 px-2 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{topic.name}</span>
        <button onClick={() => onDelete(topic)} className="text-xs text-red-600">
          Delete
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-xs text-neutral-500">Dedup cooldown</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="default"
          inputMode="numeric"
          className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <span className="text-xs text-neutral-400">sec</span>
        <button
          onClick={() => onSaveCooldown(topic, value)}
          className="rounded bg-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700"
        >
          Save
        </button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------ escalation --- */

/**
 * Escalation, grouped by topic.
 *
 * The previous view listed every rule in one flat list, with a step number the
 * user had to type in by hand — which made a chain (an inherently ordered,
 * per-topic thing) close to unreadable. Here each topic shows its own chain in
 * order, and the server assigns the step number when a step is appended.
 */
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
  const [addingTo, setAddingTo] = useState<string | null>(null);

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

  async function remove(id: string) {
    try {
      await api.deleteEscalationRule(id);
      onStatus('Step removed');
      await load();
    } catch (e) {
      onError(e);
    }
  }

  const userName = (id: string | null) =>
    id
      ? (users.find((u) => u.id === id)?.name ?? 'unknown')
      : 'everyone subscribed';

  // "All topics" (topic_id = null) is a real group and is listed first.
  const groups: { key: string; topicId: string | null; label: string }[] = [
    { key: 'all', topicId: null, label: 'All topics' },
    ...topics.map((t) => ({ key: t.id, topicId: t.id as string | null, label: t.name })),
  ];

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Escalation chains
      </h2>
      <p className="mb-3 text-xs text-neutral-500">
        If nobody acknowledges within the delay, the alert escalates to the next
        step.{' '}
        <strong>Any acknowledgement, from anyone, cancels the whole chain.</strong>
      </p>

      <div className="space-y-3">
        {groups.map((g) => {
          const chain = rules
            .filter((r) => r.topicId === g.topicId)
            .sort((a, b) => a.stepOrder - b.stepOrder);

          return (
            <div key={g.key} className="rounded border border-neutral-200 p-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {g.label}
                  {g.topicId === null && (
                    <span className="ml-1 text-xs font-normal text-neutral-400">
                      (applies to every topic)
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setAddingTo(addingTo === g.key ? null : g.key)}
                  className="text-xs font-medium text-indigo-700"
                >
                  {addingTo === g.key ? 'Cancel' : '+ Add step'}
                </button>
              </div>

              {chain.length === 0 ? (
                <p className="mt-1 text-xs text-neutral-400">
                  No escalation — an unacknowledged alert here simply sits there.
                </p>
              ) : (
                <ol className="mt-2 space-y-1">
                  {chain.map((r, i) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between rounded bg-neutral-50 px-2 py-1"
                    >
                      <span className="text-xs">
                        <span className="font-semibold">{i + 1}.</span>{' '}
                        {i === 0 ? 'After' : 'Then after'}{' '}
                        <strong>{r.delaySeconds}s</strong> →{' '}
                        {r.nextChannel === 'action' ? (
                          <>
                            ⚙️ <strong>run the alert's action</strong>, tell{' '}
                            <strong>{userName(r.nextUserId)}</strong> by SMS
                          </>
                        ) : (
                          <>
                            {r.nextChannel} to{' '}
                            <strong>{userName(r.nextUserId)}</strong>
                          </>
                        )}
                        <span className="ml-1 text-neutral-400">
                          ({r.minPriority}+)
                        </span>
                      </span>
                      <button
                        onClick={() => remove(r.id)}
                        className="ml-2 text-xs text-red-600"
                        title="Remove this step"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ol>
              )}

              {addingTo === g.key && (
                <AddStepForm
                  topicId={g.topicId}
                  users={users}
                  onDone={async () => {
                    setAddingTo(null);
                    onStatus('Step added to the chain');
                    await load();
                  }}
                  onError={onError}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AddStepForm({
  topicId,
  users,
  onDone,
  onError,
}: {
  topicId: string | null;
  users: ManagedUser[];
  onDone: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [minPriority, setMinPriority] = useState('critical');
  const [delay, setDelay] = useState('180');
  const [channel, setChannel] = useState('sms');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      // No step_order is sent: the server appends this step to the end of the
      // topic's chain. Asking a person to pick a step number is implementation
      // detail leaking into the UI, and getting it wrong leaves a gap.
      await api.createEscalationRule({
        topic_id: topicId,
        min_priority: minPriority,
        delay_seconds: Number(delay),
        next_channel: channel,
        next_user_id: userId || null,
      });
      await onDone();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-neutral-100 pt-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Triggers at</span>
          <select
            value={minPriority}
            onChange={(e) => setMinPriority(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}+
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Wait (seconds)</span>
          <input
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            inputMode="numeric"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Then</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="sms">send an SMS</option>
            <option value="webpush">send a push</option>
            <option value="action">run the alert's action ⚙️</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">
            {channel === 'action' ? 'Report the result to' : 'To'}
          </span>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">Everyone subscribed</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {channel === 'action' && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <strong>This step lets the system act on its own.</strong> It runs the
          actions the sender marked <code>"escalate": true</code> on that
          particular alert — closing the valve nobody came to close. It then
          reports the outcome: an SMS to the person above, and a push to everyone.
          <br />
          <br />
          Only ever mark an action escalatable if it moves things to a{' '}
          <strong>safe</strong> state — closing a valve, cutting power. Never one
          that unlocks a door. And note: any acknowledgement, from anyone, cancels
          the chain before this runs.
        </p>
      )}

      <button
        onClick={create}
        disabled={busy}
        className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Adding…' : 'Add step to chain'}
      </button>
    </div>
  );
}
