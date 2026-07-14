import type { AppConfig } from '../config.js';
import { sendActionWebhook } from '../lib/webhook.js';
import type { ActionInvoker, NotificationAction } from '../router/types.js';

/**
 * Invokes an action's webhook on behalf of the escalation, using exactly the
 * same signed call a human button press makes.
 *
 * The receiving end can tell the difference: the payload carries
 * `triggered_by: "escalation"` and no user. That matters — Home Assistant may
 * reasonably want to log an unattended valve closure differently from one a
 * person chose.
 */
export class WebhookActionInvoker implements ActionInvoker {
  constructor(private readonly config: AppConfig) {}

  async invoke(
    action: NotificationAction,
    context: {
      messageId: string;
      title: string;
      priority: string;
      topic: string | null;
    },
  ): Promise<{ ok: boolean; httpStatus: number | null; error: string | null }> {
    if (!action.url) {
      return { ok: false, httpStatus: null, error: 'Action has no URL' };
    }

    const secret =
      this.config.WEBHOOK_SIGNING_SECRET ?? this.config.SESSION_SECRET;

    const result = await sendActionWebhook(action.url, secret, {
      message_id: context.messageId,
      action_id: action.id,
      user_id: null,
      user_name: null,
      topic: context.topic,
      priority: context.priority,
      title: context.title,
      triggered_at: new Date().toISOString(),
      triggered_by: 'escalation',
    });

    return { ok: result.ok, httpStatus: result.httpStatus, error: result.error };
  }
}
