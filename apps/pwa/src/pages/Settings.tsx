import { useEffect, useState } from 'react';
import { api, type Me, type Topic } from '../lib/api.js';
import { AdminPanel } from '../components/AdminPanel.js';
import { ApiKeys } from '../components/ApiKeys.js';
import { MyProfile } from '../components/MyProfile.js';
import { Devices } from '../components/Devices.js';
import { HomeAssistantSetup } from '../components/HomeAssistantSetup.js';

const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const CHANNELS = ['auto', 'push_only', 'sms_only'];

export function Settings({
  me,
  onProfileUpdated,
}: {
  me: Me;
  onProfileUpdated: (me: Me) => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [household, setHousehold] = useState<string>('');

  const isAdmin = me.role === 'admin';

  useEffect(() => {
    void api.topics().then(setTopics);
    void api.tenant().then((t) => setHousehold(t.name)).catch(() => {});
  }, []);

  // Defensive: the profile should always carry subscriptions (login and /v1/me
  // now build it from the same function), but a missing list must degrade to
  // "no preferences saved yet" rather than crash the tab.
  const subByTopic = new Map(
    (me.subscriptions ?? []).map((s) => [s.topicId, s]),
  );

  async function save(
    topicId: string,
    patch: {
      min_priority: string;
      quiet_start: string | null;
      quiet_end: string | null;
      channel_pref: string;
    },
  ) {
    setSaving(topicId);
    setStatus(null);
    try {
      await api.putSubscription({ topic_id: topicId, ...patch });
      setStatus('Saved');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-4">
      <h1 className="mb-1 text-xl font-semibold">
        {household ? `${household} — Settings` : 'Settings'}
      </h1>
      <p className="mb-4 text-sm text-neutral-500">
        Signed in as {me.name}
        {me.sms_number ? ` · SMS ${me.sms_number}` : ''}
      </p>

      {/* Own profile first: this is where a user sets the SMS number that makes
          critical alerts able to reach them at all. */}
      <div className="mb-8">
        <MyProfile me={me} onUpdated={onProfileUpdated} />
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Topic preferences
      </h2>
      <ul className="space-y-4">
        {topics.map((topic) => {
          const sub = subByTopic.get(topic.id);
          return (
            <TopicRow
              key={topic.id}
              topic={topic}
              minPriority={sub?.minPriority ?? 'normal'}
              quietStart={sub?.quietStart ?? null}
              quietEnd={sub?.quietEnd ?? null}
              channelPref={sub?.channelPref ?? 'auto'}
              saving={saving === topic.id}
              onSave={(patch) => save(topic.id, patch)}
            />
          );
        })}
      </ul>
      {status && <p className="mt-3 text-sm text-neutral-500">{status}</p>}

      <div className="mt-8">
        <Devices />
      </div>

      <div className="mt-8">
        <HomeAssistantSetup />
      </div>

      {/* Every user manages their own sender tokens — no admin needed. */}
      <div className="mt-8">
        <ApiKeys isAdmin={isAdmin} />
      </div>

      {isAdmin && (
        <div className="mt-8 border-t border-neutral-200 pt-6">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Administration
          </p>
          <AdminPanel onTenantRenamed={setHousehold} currentUserId={me.id} />
        </div>
      )}

      <div className="mt-8 space-y-2">
        <button
          onClick={() => api.logout().then(() => location.reload())}
          className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm"
        >
          Log out
        </button>
        <button
          onClick={() => {
            if (
              confirm(
                'Sign out on every device, including this one? Use this if a phone was lost.',
              )
            ) {
              void api.logoutAll().then(() => location.reload());
            }
          }}
          className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm text-red-600"
        >
          Log out all devices
        </button>
        <p className="pt-1 text-center text-xs text-neutral-400">
          You stay signed in for as long as you keep using the app — there is no
          periodic logout.
        </p>
        <p className="text-center text-xs text-neutral-300">
          Build {new Date(__BUILD_TIME__).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

function TopicRow(props: {
  topic: Topic;
  minPriority: string;
  quietStart: string | null;
  quietEnd: string | null;
  channelPref: string;
  saving: boolean;
  onSave: (patch: {
    min_priority: string;
    quiet_start: string | null;
    quiet_end: string | null;
    channel_pref: string;
  }) => void;
}) {
  const [minPriority, setMinPriority] = useState(props.minPriority);
  const [quietStart, setQuietStart] = useState(props.quietStart ?? '');
  const [quietEnd, setQuietEnd] = useState(props.quietEnd ?? '');
  const [channelPref, setChannelPref] = useState(props.channelPref);

  return (
    <li className="rounded-lg border border-neutral-200 p-3">
      <div className="font-medium">{props.topic.name}</div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Min priority</span>
          <select
            value={minPriority}
            onChange={(e) => setMinPriority(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Channel</span>
          <select
            value={channelPref}
            onChange={(e) => setChannelPref(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Quiet from</span>
          <input
            type="time"
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-neutral-500">Quiet until</span>
          <input
            type="time"
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>
      </div>
      <button
        disabled={props.saving}
        onClick={() =>
          props.onSave({
            min_priority: minPriority,
            quiet_start: quietStart || null,
            quiet_end: quietEnd || null,
            channel_pref: channelPref,
          })
        }
        className="mt-3 rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
      >
        {props.saving ? 'Saving…' : 'Save'}
      </button>
    </li>
  );
}
