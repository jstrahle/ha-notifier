import { useEffect, useState } from 'react';
import { api, type Device } from '../lib/api.js';

/**
 * The devices this user receives push notifications on.
 *
 * Push subscriptions accumulate: reinstalling the app, switching browsers or
 * clearing site data all create a new one and leave the old behind. Dead ones
 * are pruned automatically when the push service reports them gone, but a device
 * you simply no longer use is not dead — it will keep receiving your alerts.
 */
export function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .devices()
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  async function remove(d: Device) {
    if (!confirm('Stop sending push notifications to this device?')) return;
    setBusy(d.id);
    try {
      await api.deleteDevice(d.id);
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
        My devices
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        Where your push notifications are delivered. Old entries pile up after
        reinstalls — remove any you no longer use.
      </p>

      {error && (
        <p className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {devices.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No devices registered. Enable notifications on this device to add one.
        </p>
      ) : (
        <ul className="space-y-1">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between rounded border border-neutral-200 px-2 py-1 text-sm"
            >
              <span>
                {d.platform ?? 'unknown device'}
                <span className="ml-2 text-xs text-neutral-400">
                  added {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </span>
              <button
                onClick={() => remove(d)}
                disabled={busy === d.id}
                className="text-xs text-red-600 disabled:opacity-50"
              >
                {busy === d.id ? '…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
