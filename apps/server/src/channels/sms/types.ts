/**
 * SMS provider abstraction. The router and worker depend only on this
 * interface, so the commercial branch can add providers (centralised gateway,
 * Vonage, etc.) without touching routing logic.
 *
 * `enabled` lets the router know whether SMS is actually deliverable. Without
 * it, a critical message to a user who has a phone number but no configured
 * provider would queue an SMS delivery that can only ever fail.
 */
export interface SmsProvider {
  readonly enabled: boolean;
  send(to: string, text: string): Promise<{ providerId: string; status: string }>;
}

export class SmsDisabledError extends Error {
  constructor() {
    super('SMS channel is disabled (SMS_PROVIDER=none)');
    this.name = 'SmsDisabledError';
  }
}
