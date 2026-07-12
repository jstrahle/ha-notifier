import webpush from 'web-push';
import type { AppConfig } from '../config.js';
import type { NotificationAction } from '../router/types.js';

/**
 * Web Push delivery. We speak the standard Web Push protocol; the browser
 * vendor's push service (Apple Push Service for iOS Safari, FCM-backed for
 * Chrome/Android) handles the last hop. We never talk to FCM/APNs directly.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  priority: string;
  tag?: string | null;
  actions?: NotificationAction[] | null;
  /**
   * `ackToken` lets the service worker acknowledge straight from a notification
   * button without relying on the browser session cookie, which may have
   * expired by the time the alert fires.
   */
  data: { messageId: string; deliveryId: string; ackToken: string | null };
}

export type PushSendResult =
  | { ok: true }
  | { ok: false; gone: boolean; error: string };

export class WebPushChannel {
  constructor(config: AppConfig) {
    webpush.setVapidDetails(
      config.VAPID_SUBJECT,
      config.VAPID_PUBLIC_KEY,
      config.VAPID_PRIVATE_KEY,
    );
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushSendResult> {
    try {
      await webpush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        JSON.stringify(payload),
      );
      return { ok: true };
    } catch (err: unknown) {
      const statusCode =
        typeof err === 'object' && err !== null && 'statusCode' in err
          ? (err as { statusCode?: number }).statusCode
          : undefined;
      // 404/410 => subscription is dead and must be removed.
      const gone = statusCode === 404 || statusCode === 410;
      return {
        ok: false,
        gone,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
