import { useState } from 'react';
import { api, type Me } from '../lib/api.js';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Returns the same shape as /v1/me, so the app has a complete profile
      // immediately and does not need a reload to populate Settings.
      const me = await api.login(name, password);
      onLogin(me);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-2xl font-semibold">Home Notifications</h1>
      <p className="mt-1 text-sm text-neutral-500">Sign in to continue</p>
      <div className="mt-6 space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoCapitalize="none"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
