import type { SmsProvider } from './types.js';

/**
 * Twilio SMS provider.
 *
 * Implemented against Twilio's REST API with the built-in `fetch` rather than
 * the official SDK. The SDK pulls in a large dependency tree (including several
 * deprecated transitive packages) to wrap what is a single form-encoded POST.
 * Keeping this hand-rolled keeps the image small and the audit surface clean.
 */
export class TwilioProvider implements SmsProvider {
  readonly enabled = true;
  private readonly endpoint: string;
  private readonly authHeader: string;

  constructor(
    accountSid: string,
    authToken: string,
    private readonly from: string,
  ) {
    this.endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid,
    )}/Messages.json`;
    this.authHeader =
      'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  }

  async send(
    to: string,
    text: string,
  ): Promise<{ providerId: string; status: string }> {
    const body = new URLSearchParams({ To: to, From: this.from, Body: text });

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const payload = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
      code?: number;
    };

    if (!res.ok) {
      throw new Error(
        `Twilio error ${res.status}: ${payload.message ?? 'unknown'}${
          payload.code ? ` (code ${payload.code})` : ''
        }`,
      );
    }

    return { providerId: payload.sid ?? '', status: payload.status ?? 'queued' };
  }
}
