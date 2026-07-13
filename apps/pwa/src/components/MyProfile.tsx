import { useState } from 'react';
import { api, type Me } from '../lib/api.js';

/**
 * Your own profile.
 *
 * This closes a genuine hole: the only way to set a phone number used to be
 * `PATCH /v1/users/:id`, which is admin-only — and the seeded admin is created
 * with no number at all. So the one person most likely to want a 3am SMS could
 * never receive one, and an ordinary family member could not even change their
 * own password.
 */
export function MyProfile({
  me,
  onUpdated,
}: {
  me: Me;
  onUpdated: (me: Me) => void;
}) {
  const [sms, setSms] = useState(me.sms_number ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const smsChanged = (me.sms_number ?? '') !== sms.trim();
  const canSave = smsChanged || password.length >= 8;

  async function save() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const body: { sms_number?: string | null; password?: string } = {};
      if (smsChanged) body.sms_number = sms.trim() === '' ? null : sms.trim();
      if (password.length >= 8) body.password = password;

      const updated = await api.patchMe(body);
      onUpdated(updated);
      setPassword('');
      setStatus(
        password.length >= 8
          ? 'Saved. Your other devices have been signed out.'
          : 'Saved.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        My profile
      </h2>

      <div className="space-y-2">
        <label className="block">
          <span className="text-xs text-neutral-500">
            SMS number — this is what lets a critical alert reach a silenced phone
          </span>
          <input
            value={sms}
            onChange={(e) => setSms(e.target.value)}
            placeholder="+358401234567"
            inputMode="tel"
            className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>

        {!me.sms_number && (
          <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            You have no SMS number set, so critical alerts can only reach you as a
            web push — which cannot wake a silenced phone. Add one, then save the
            sending number as a contact with <strong>Emergency Bypass</strong>{' '}
            enabled.
          </p>
        )}

        <label className="block">
          <span className="text-xs text-neutral-500">
            New password (leave blank to keep the current one)
          </span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="At least 8 characters"
            className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>

        <button
          onClick={save}
          disabled={busy || !canSave}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save profile'}
        </button>

        {status && <p className="text-xs text-green-700">{status}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </section>
  );
}
