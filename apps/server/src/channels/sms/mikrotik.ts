import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import type { SmsProvider } from './types.js';
import { toGsm7Sms } from '../../lib/gsm7.js';

/**
 * MikroTik RouterOS SMS provider.
 *
 * Sends through the router's own LTE modem via the RouterOS v7 REST API:
 *
 *   POST /rest/tool/sms/send
 *   { "port": "lte1", "phone-number": "+358...", "message": "..." }
 *
 * Why this exists: a rented cloud SMS number costs a monthly fee forever,
 * whereas a prepaid SIM in the router you already own is pay-per-message. It
 * also keeps the one property that makes critical alerts work at all — the
 * message arrives from a real phone number, so the recipient can save it as a
 * contact and enable iOS Emergency Bypass.
 *
 * Reachability: the router lives behind NAT at home and the server runs on a
 * public VPS, so the router dials *out* to the VPS over WireGuard and we talk
 * to it on the tunnel address. The router's management API is never exposed to
 * the internet. See docs/MIKROTIK_SMS.md.
 *
 * Transport: plain HTTP over the tunnel is acceptable and is the default, since
 * WireGuard already encrypts and authenticates the link. HTTPS is supported for
 * defence in depth; RouterOS self-signed certificates can be trusted by
 * pointing MIKROTIK_CA_CERT at the exported CA.
 */

export interface MikrotikOptions {
  /** Base URL of the router on the tunnel, e.g. http://10.10.10.2 */
  baseUrl: string;
  username: string;
  password: string;
  /** RouterOS port/interface name carrying the modem, e.g. "lte1". */
  smsPort: string;
  /** PEM of the router's CA, when using HTTPS with a self-signed certificate. */
  caCertPath?: string | undefined;
  timeoutMs?: number;
}

interface RouterOsError {
  error?: number;
  message?: string;
  detail?: string;
}

export class MikrotikProvider implements SmsProvider {
  readonly enabled = true;

  private readonly url: URL;
  private readonly authHeader: string;
  private readonly ca: Buffer | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: MikrotikOptions) {
    this.url = new URL('/rest/tool/sms/send', options.baseUrl);
    this.authHeader =
      'Basic ' +
      Buffer.from(`${options.username}:${options.password}`).toString('base64');
    this.ca = options.caCertPath
      ? readFileSync(options.caCertPath)
      : undefined;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async send(
    to: string,
    text: string,
  ): Promise<{ providerId: string; status: string }> {
    // RouterOS silently drops characters outside GSM-7, so we sanitise here
    // rather than discover it from a mangled alert.
    const message = toGsm7Sms(text);

    const body = JSON.stringify({
      port: this.options.smsPort,
      'phone-number': to,
      message,
    });

    const { statusCode, payload } = await this.post(body);

    if (statusCode < 200 || statusCode >= 300) {
      const err = safeParse(payload);
      const detail = err?.detail ?? err?.message ?? payload.slice(0, 200);
      throw new Error(
        `RouterOS SMS failed (HTTP ${statusCode}): ${detail || 'no detail'}`,
      );
    }

    // A successful send returns an empty body or an empty JSON array. RouterOS
    // gives us no message id, so we synthesise one for the delivery record.
    return { providerId: `routeros:${Date.now()}`, status: 'sent' };
  }

  private post(
    body: string,
  ): Promise<{ statusCode: number; payload: string }> {
    const isHttps = this.url.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const req = doRequest(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port || (isHttps ? 443 : 80),
          path: this.url.pathname,
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          ...(isHttps && this.ca ? { ca: this.ca } : {}),
          timeout: this.timeoutMs,
        },
        (res) => {
          let payload = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            payload += chunk;
          });
          res.on('end', () =>
            resolve({ statusCode: res.statusCode ?? 0, payload }),
          );
        },
      );

      req.on('timeout', () => {
        req.destroy(
          new Error(
            `RouterOS did not respond within ${this.timeoutMs}ms — is the WireGuard tunnel up?`,
          ),
        );
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

function safeParse(payload: string): RouterOsError | null {
  try {
    return JSON.parse(payload) as RouterOsError;
  } catch {
    return null;
  }
}
