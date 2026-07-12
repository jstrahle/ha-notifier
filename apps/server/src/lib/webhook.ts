import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Outbound action webhooks.
 *
 * When a user presses an action button ("Unlock door", "Silence alarm"), we call
 * back into the home automation system. That callback can perform real physical
 * actions, so the receiver must be able to prove the request came from us and is
 * not a replay. We therefore send a JSON body plus an HMAC-SHA256 signature over
 * `timestamp.body`, in the same style as Stripe and GitHub webhooks.
 *
 * The receiver should:
 *   1. reject requests whose timestamp is older than a few minutes,
 *   2. recompute the HMAC over `${timestamp}.${rawBody}` and compare in
 *      constant time.
 */

export interface ActionWebhookPayload {
  message_id: string;
  action_id: string;
  user_id: string;
  user_name: string;
  topic: string | null;
  priority: string;
  title: string;
  triggered_at: string;
}

export const SIGNATURE_HEADER = 'x-notify-signature';
export const TIMESTAMP_HEADER = 'x-notify-timestamp';

export function signPayload(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `sha256=${mac}`;
}

/** Provided for receivers written against this codebase, and for tests. */
export function verifySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface WebhookResult {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
}

/**
 * Delivers the action webhook. Never throws: the caller records the outcome so
 * the user can see whether their button press actually reached the house.
 */
export async function sendActionWebhook(
  url: string,
  secret: string,
  payload: ActionWebhookPayload,
  timeoutMs = 10_000,
): Promise<WebhookResult> {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signPayload(secret, timestamp, rawBody),
        [TIMESTAMP_HEADER]: timestamp,
      },
      body: rawBody,
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      httpStatus: res.status,
      error: res.ok ? null : `Receiver returned ${res.status}`,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, httpStatus: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}
