import type { AppConfig } from '../../config.js';
import { TwilioProvider } from './twilio.js';
import { MikrotikProvider } from './mikrotik.js';
import { SmsDisabledError, type SmsProvider } from './types.js';

/**
 * No-op provider used when SMS is disabled. `enabled: false` tells the router
 * not to select the SMS channel at all, so no doomed deliveries are queued.
 */
export class NoneProvider implements SmsProvider {
  readonly enabled = false;
  async send(): Promise<{ providerId: string; status: string }> {
    throw new SmsDisabledError();
  }
}

export function createSmsProvider(config: AppConfig): SmsProvider {
  switch (config.SMS_PROVIDER) {
    case 'twilio':
      return new TwilioProvider(
        config.TWILIO_ACCOUNT_SID!,
        config.TWILIO_AUTH_TOKEN!,
        config.TWILIO_FROM_NUMBER!,
      );

    case 'mikrotik':
      // Sends through the router's own LTE modem over the WireGuard tunnel.
      // No monthly number rental, and the alert still arrives from a real
      // phone number so iOS Emergency Bypass works.
      return new MikrotikProvider({
        baseUrl: config.MIKROTIK_URL!,
        username: config.MIKROTIK_USER!,
        password: config.MIKROTIK_PASSWORD!,
        smsPort: config.MIKROTIK_SMS_PORT,
        caCertPath: config.MIKROTIK_CA_CERT,
      });

    default:
      return new NoneProvider();
  }
}

export { type SmsProvider, SmsDisabledError } from './types.js';
