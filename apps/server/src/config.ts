import { z } from 'zod';

/**
 * Central configuration. All environment input is validated here so the rest
 * of the app can rely on well-typed, present values. Fail fast on boot if the
 * environment is misconfigured.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  APP_URL: z.string().url(),
  TENANT_NAME: z.string().default('Home'),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  VAPID_PUBLIC_KEY: z.string(),
  VAPID_PRIVATE_KEY: z.string(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),

  SMS_PROVIDER: z.enum(['twilio', 'mikrotik', 'none']).default('none'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  // --- MikroTik RouterOS (SMS via the router's own LTE modem) ---
  // The router is reached over the WireGuard tunnel, never over the internet.
  MIKROTIK_URL: z.string().url().optional(),
  MIKROTIK_USER: z.string().optional(),
  MIKROTIK_PASSWORD: z.string().optional(),
  /** RouterOS interface carrying the modem, as shown by `/tool sms print`. */
  MIKROTIK_SMS_PORT: z.string().default('lte1'),
  /** PEM of the router's CA, only needed when MIKROTIK_URL uses https. */
  MIKROTIK_CA_CERT: z.string().optional(),

  MQTT_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  MQTT_URL: z.string().default('mqtt://localhost:1883'),
  MQTT_TOPIC_PREFIX: z.string().default('notify/'),

  SESSION_SECRET: z.string().min(16),
  /**
   * Secret used to sign outbound action webhooks. Optional: falls back to
   * SESSION_SECRET so existing installs keep working, but a dedicated secret is
   * better because it can be shared with Home Assistant without handing over the
   * key that signs login sessions.
   */
  WEBHOOK_SIGNING_SECRET: z.string().min(16).optional(),
  /**
   * How long a login lasts. Default 400 days — the longest value browsers will
   * honour (Chrome caps cookie Max-Age at 400 days; anything larger is clamped).
   * The session slides: it is re-issued while the app is in use, so an active
   * user is never logged out.
   */
  SESSION_MAX_AGE_DAYS: z.coerce.number().min(1).max(400).default(400),
  ACK_TOKEN_TTL_SECONDS: z.coerce.number().default(3600),
  DEDUP_COOLDOWN_SECONDS: z.coerce.number().default(300),
});

export type AppConfig = z.infer<typeof schema>;

/**
 * Validates the TZ environment variable.
 *
 * Quiet hours are evaluated in the server's local time, which Node takes from
 * TZ. Node accepts an invalid TZ value silently and falls back to UTC, so a
 * typo like `Europe/Helsingfors` would shift every quiet-hours window by the
 * UTC offset with no error anywhere. We therefore check it explicitly on boot.
 *
 * TZ must be an IANA tz database name ("Area/Location", e.g. Europe/Helsinki).
 * Abbreviations (EET) and UTC offsets (GMT+2, +02:00) are not accepted: an
 * offset cannot express daylight saving time.
 */
export function validateTimezone(tz: string | undefined): void {
  if (!tz) return; // Not set: Node uses the system zone, which is fine.

  const fail = (): never => {
    throw new Error(
      `Invalid TZ value: "${tz}".\n` +
        '  TZ must be an IANA tz database name, e.g. "Europe/Helsinki", "America/New_York" or "UTC".\n' +
        '  Abbreviations ("EET") and offsets ("GMT+2", "+02:00") are not supported.\n' +
        '  Find yours with: timedatectl show --property=Timezone --value',
    );
  };

  // Shape check first. Intl accepts offset identifiers such as "+02:00", so
  // checking with Intl alone would let a DST-incapable value through.
  const isUtc = tz === 'UTC';
  const isAreaLocation = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz);
  if (!isUtc && !isAreaLocation) fail();

  // Then confirm the runtime actually knows this zone (catches typos).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    fail();
  }
}

let cached: AppConfig | null = null;

/** RFC1918 / loopback / link-local check for the router's tunnel address. */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  validateTimezone(env.TZ);
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.SMS_PROVIDER === 'twilio') {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } =
      parsed.data;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
      throw new Error(
        'SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER',
      );
    }
  }

  if (parsed.data.SMS_PROVIDER === 'mikrotik') {
    const { MIKROTIK_URL, MIKROTIK_USER, MIKROTIK_PASSWORD } = parsed.data;
    if (!MIKROTIK_URL || !MIKROTIK_USER || !MIKROTIK_PASSWORD) {
      throw new Error(
        'SMS_PROVIDER=mikrotik requires MIKROTIK_URL, MIKROTIK_USER and MIKROTIK_PASSWORD',
      );
    }
    // A public hostname here means the router's management API is exposed to
    // the internet. That is the one configuration we refuse to boot with.
    const host = new URL(MIKROTIK_URL).hostname;
    if (!isPrivateHost(host)) {
      throw new Error(
        `MIKROTIK_URL points at "${host}", which is not a private address.\n` +
          '  The router must be reached over the WireGuard tunnel (e.g. http://10.10.10.2),\n' +
          "  never over the internet — this URL is the router's full management API.\n" +
          '  See docs/MIKROTIK_SMS.md.',
      );
    }
  }
  cached = parsed.data;
  return cached;
}
