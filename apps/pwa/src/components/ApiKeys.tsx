import { useEffect, useState } from 'react';
import { api, type ApiKey } from '../lib/api.js';

/**
 * API key management.
 *
 * These are the tokens senders (Home Assistant, scripts) put in the
 * `Authorization: Bearer` header. Every user manages their own — creating and
 * rotating a token should not require an admin, and rotation is the thing you
 * need in a hurry when a token may have leaked.
 *
 * The plaintext secret is shown exactly once. Only its hash is stored, so it
 * cannot be recovered later — the UI is explicit about that.
 */
export function ApiKeys({ isAdmin }: { isAdmin: boolean }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .apiKeys()
      .then(setKeys)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy('create');
    setError(null);
    try {
      const res = await api.createApiKey(name.trim());
      setRevealed({ name: res.name, key: res.key });
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function rotate(k: ApiKey) {
    if (
      !confirm(
        `Rotate "${k.name}"? The current token stops working immediately and any sender using it must be updated.`,
      )
    )
      return;
    setBusy(k.id);
    setError(null);
    try {
      const res = await api.rotateApiKey(k.id);
      setRevealed({ name: res.name, key: res.key });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(k: ApiKey) {
    if (!confirm(`Delete "${k.name}"? Senders using it will stop working.`)) return;
    setBusy(k.id);
    try {
      await api.deleteApiKey(k.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        API keys
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        Used by senders in the <code>Authorization: Bearer</code> header.
        {isAdmin && ' As an admin you can see every key in the household.'}
      </p>

      {error && (
        <p className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {revealed && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-2">
          <p className="text-xs font-medium text-amber-900">
            New token for "{revealed.name}" — copy it now, it is shown only once.
          </p>
          <code className="mt-1 block break-all rounded bg-white p-2 text-xs">
            {revealed.key}
          </code>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => navigator.clipboard?.writeText(revealed.key)}
              className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white"
            >
              Copy
            </button>
            <button
              onClick={() => setRevealed(null)}
              className="text-xs text-amber-900"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <ul className="mb-3 space-y-1">
        {keys.length === 0 && (
          <li className="text-sm text-neutral-500">No keys yet.</li>
        )}
        {keys.map((k) => (
          <li
            key={k.id}
            className="rounded border border-neutral-200 px-2 py-1 text-sm"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{k.name}</span>
              <span className="text-xs text-neutral-400">
                {k.scopes.join(', ')}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-neutral-500">
                {k.mine
                  ? 'yours'
                  : k.ownerName
                    ? `owned by ${k.ownerName}`
                    : 'household key'}
                {' · '}
                {k.lastUsedAt
                  ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                  : 'never used'}
              </span>
              <span className="flex gap-2">
                <button
                  onClick={() => rotate(k)}
                  disabled={busy === k.id}
                  className="text-xs font-medium text-indigo-700 disabled:opacity-50"
                >
                  {busy === k.id ? '…' : 'Rotate'}
                </button>
                <button
                  onClick={() => remove(k)}
                  disabled={busy === k.id}
                  className="text-xs text-red-600 disabled:opacity-50"
                >
                  Delete
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New key name, e.g. home-assistant"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <button
          onClick={create}
          disabled={busy === 'create' || !name.trim()}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === 'create' ? 'Creating…' : 'Create'}
        </button>
      </div>
    </section>
  );
}
