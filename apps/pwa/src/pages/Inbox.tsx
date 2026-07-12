import { useEffect, useState } from 'react';
import { api, type InboxItem } from '../lib/api.js';

const priorityColor: Record<string, string> = {
  low: 'bg-neutral-200 text-neutral-700',
  normal: 'bg-sky-100 text-sky-800',
  high: 'bg-amber-100 text-amber-800',
  critical: 'bg-red-100 text-red-800',
};

export function Inbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});

  async function load() {
    try {
      setItems(await api.messages());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      const pending = new URLSearchParams(location.search).get('ack');
      if (pending) {
        // Clear it first so a refresh does not re-trigger.
        history.replaceState({}, '', location.pathname);
        try {
          await api.ackDelivery(pending);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      await load();
    })();
  }, []);

  /**
   * Acknowledge the alert, not one copy of it. The server clears every channel
   * the alert went out on for this user, so a critical alert delivered by both
   * push and SMS is done with in one tap.
   */
  async function ack(item: InboxItem) {
    setError(null);
    try {
      await api.ackMessage(item.id);
      await load();
    } catch (e) {
      // Surface failures instead of leaving the button looking inert.
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Trigger an action button from the app.
   *
   * This is not merely a convenience: iOS does not render notification action
   * buttons at all, so for iPhone users this is the ONLY way to press one.
   * The server returns 502 if the webhook did not reach the house, and we show
   * that rather than pretending the door unlocked.
   */
  async function trigger(item: InboxItem, actionId: string) {
    const key = `${item.id}:${actionId}`;
    setError(null);
    setBusyAction(key);
    try {
      await api.triggerAction(item.id, actionId);
      setDone((d) => ({ ...d, [key]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  if (loading) return <p className="p-6 text-sm text-neutral-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-md px-4 py-4">
      <h1 className="mb-4 text-xl font-semibold">Inbox</h1>
      {error && (
        <p className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {items.length === 0 && (
        <p className="text-sm text-neutral-500">No notifications yet.</p>
      )}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border border-neutral-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  priorityColor[item.priority] ?? priorityColor.normal
                }`}
              >
                {item.priority}
              </span>
              <span className="text-xs text-neutral-400">
                {new Date(item.createdAt).toLocaleString()}
              </span>
            </div>
            <h2 className="mt-2 font-medium">{item.title}</h2>
            <p className="whitespace-pre-line text-sm text-neutral-600">{item.body}</p>

            {item.duplicateCount > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Repeated {item.duplicateCount}× since
              </p>
            )}

            {/* Action buttons. On iOS these are the only way to press an action,
                because Safari does not render notification action buttons. */}
            {item.actions && item.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {item.actions
                  .filter((a) => a.id !== 'ack')
                  .map((a) => {
                    const key = `${item.id}:${a.id}`;
                    return (
                      <button
                        key={a.id}
                        onClick={() => trigger(item, a.id)}
                        disabled={busyAction === key || done[key]}
                        className="rounded border border-indigo-300 px-3 py-1 text-xs font-medium text-indigo-700 disabled:opacity-50"
                      >
                        {done[key]
                          ? `✓ ${a.label}`
                          : busyAction === key
                            ? 'Sending…'
                            : a.label}
                      </button>
                    );
                  })}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-neutral-400">
                {/* One alert, however many channels carried it. */}
                {item.channels.join(' + ')}
                {item.acknowledged && ' · acknowledged'}
                {!item.acknowledged && item.failed && ' · delivery failed'}
              </span>
              {!item.acknowledged && (
                <button
                  onClick={() => ack(item)}
                  className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white"
                >
                  Acknowledge
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
