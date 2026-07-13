import type { NotificationAction } from '../router/types.js';

/**
 * The shape of an action as a client is allowed to see it.
 *
 * Deliberately has no `url`. An action's URL is a Home Assistant webhook
 * endpoint, and Home Assistant's own documentation is blunt about what that is:
 * "Treat a webhook ID like a password." A webhook that can unlock the front door
 * is exactly that.
 *
 * The client never needs it. When a button is pressed, the browser calls *our*
 * server (`POST /v1/actions/:messageId/:actionId`); the server then looks the URL
 * up from the database and makes the signed outbound call itself. So sending the
 * URL to the browser accomplishes nothing except copying a password onto every
 * family member's phone, into notification payloads and into the inbox API
 * response, where it sits until the device is lost or its storage is dumped.
 */
export interface PublicAction {
  id: string;
  label: string;
}

/** Strips the webhook URL. Use this on every path that reaches a client. */
export function toPublicActions(
  actions: NotificationAction[] | null | undefined,
): PublicAction[] | null {
  if (!actions) return null;
  return actions.map(({ id, label }) => ({ id, label }));
}
