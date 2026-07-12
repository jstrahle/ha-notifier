import { useState } from 'react';
import { enablePush, isIosNeedsInstall, pushSupported } from '../lib/push.js';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsInstall = isIosNeedsInstall();

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      await enablePush();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-10">
      <h1 className="text-2xl font-semibold">Enable notifications</h1>

      {needsInstall ? (
        <div className="mt-6 space-y-4 text-sm leading-relaxed">
          <p>
            On iPhone and iPad, notifications only work after you add this app to
            your Home Screen. Please do this first:
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Tap the <span className="font-semibold">Share</span> button in
              Safari (the square with an arrow).
            </li>
            <li>
              Choose <span className="font-semibold">Add to Home Screen</span>.
            </li>
            <li>Open the app from the new Home Screen icon, then return here.</li>
          </ol>
          <p className="text-neutral-500">
            Push notifications cannot be enabled until the app runs from the Home
            Screen.
          </p>
        </div>
      ) : !pushSupported() ? (
        <p className="mt-6 text-sm text-red-600">
          This browser does not support push notifications.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <p className="text-sm leading-relaxed">
            Allow notifications so you can receive alerts from your home. Critical
            alerts may also arrive by SMS.
          </p>
          <button
            onClick={handleEnable}
            disabled={busy}
            className="w-full rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Enabling…' : 'Enable notifications'}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={onDone} className="w-full text-sm text-neutral-500">
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}
