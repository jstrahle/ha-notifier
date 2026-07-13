/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

/**
 * Service Worker.
 *
 *  - `push`: render the incoming notification. Server-supplied actions are
 *    mapped to notification buttons (browsers show at most two).
 *  - `notificationclick`: acknowledge, trigger an action, or open the app.
 *
 * Acknowledgement uses the single-use `ackToken` carried in the (end-to-end
 * encrypted) push payload and hits the session-free `POST /v1/ack/:token`.
 * Relying on the session cookie here is fragile: the alert may fire long after
 * the session expired, and iOS in particular is aggressive about evicting
 * storage for installed web apps.
 *
 * iOS note: Safari does not render notification action buttons. A plain tap is
 * therefore routed to the app with `?ack=<deliveryId>` so the user still gets a
 * one-tap Acknowledge on the device that needs it most.
 */

interface PushData {
  title: string;
  body: string;
  priority?: string;
  tag?: string | null;
  // No `url`: the server strips it. The service worker calls our own API and the
  // server makes the outbound webhook call itself.
  actions?: { id: string; label: string }[] | null;
  data: { messageId: string; deliveryId: string; ackToken: string | null };
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload: PushData;
  try {
    payload = event.data.json() as PushData;
  } catch {
    payload = {
      title: 'Notification',
      body: event.data.text(),
      data: { messageId: '', deliveryId: '', ackToken: null },
    };
  }

  const actions = (payload.actions ?? []).slice(0, 2).map((a) => ({
    action: a.id,
    title: a.label,
  }));

  // `actions` is part of the Notifications API but missing from the base
  // NotificationOptions lib type, so we widen it here.
  const options: NotificationOptions & {
    actions?: { action: string; title: string }[];
  } = {
    body: payload.body,
    tag: payload.tag ?? undefined,
    actions,
    data: payload.data,
    // Keep critical alerts on screen until the user deals with them.
    requireInteraction: payload.priority === 'critical',
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? {}) as {
    messageId?: string;
    deliveryId?: string;
    ackToken?: string | null;
  };
  const action = event.action;

  event.waitUntil(
    (async () => {
      // --- Acknowledge button ---
      if (action === 'ack') {
        const ok = await acknowledge(data);
        if (!ok) {
          // Do not fail silently: bring the user into the app so they can
          // acknowledge manually rather than believing the alert was handled.
          await openApp(
            data.deliveryId ? `/?ack=${data.deliveryId}` : '/',
          );
        }
        return;
      }

      // --- Any other action button ---
      if (action && data.messageId) {
        await fetch(`/v1/actions/${data.messageId}/${action}`, {
          method: 'POST',
          credentials: 'same-origin',
        }).catch(() => {});
        return;
      }

      // --- Plain tap: open the app, offering a one-tap acknowledge ---
      await openApp(data.deliveryId ? `/?ack=${data.deliveryId}` : '/');
    })(),
  );
});

/** Token-based acknowledge; falls back to the session route if no token. */
async function acknowledge(data: {
  deliveryId?: string;
  ackToken?: string | null;
}): Promise<boolean> {
  try {
    if (data.ackToken) {
      const res = await fetch(`/v1/ack/${data.ackToken}`, { method: 'POST' });
      if (res.ok) return true;
    }
    if (data.deliveryId) {
      const res = await fetch(`/v1/deliveries/${data.deliveryId}/ack`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      return res.ok;
    }
    return false;
  } catch {
    return false;
  }
}

async function openApp(url: string): Promise<void> {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const existing = clients[0];
  if (existing) {
    await existing.focus();
    await existing.navigate(url).catch(() => {});
    return;
  }
  await self.clients.openWindow(url);
}
