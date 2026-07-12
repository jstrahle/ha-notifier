import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { loadConfig as LoadConfig } from '../../config.js';

/**
 * The router URL is its *entire management API*. Publishing it on the router's
 * dynamic DNS name is the obvious shortcut and the one genuinely dangerous
 * mistake available here, so the server must refuse to boot on a public
 * address rather than trust the operator to remember.
 */
const base = {
  APP_URL: 'https://notify.example.com',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  SESSION_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mikrotik',
  MIKROTIK_USER: 'notify-sms',
  MIKROTIK_PASSWORD: 'secret',
} as NodeJS.ProcessEnv;

// loadConfig memoises its result, so each case needs a fresh module instance.
async function load(env: NodeJS.ProcessEnv) {
  const mod = await import('../../config.js');
  return (mod.loadConfig as typeof LoadConfig)(env);
}

describe('MikroTik URL guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([
    'http://10.10.10.2',
    'http://192.168.88.1',
    'https://172.16.0.5',
    'http://127.0.0.1:8080',
  ])('accepts the private tunnel address %s', async (url) => {
    await expect(load({ ...base, MIKROTIK_URL: url })).resolves.toBeTruthy();
  });

  it.each([
    'https://myrouter.sn.mynetname.net',
    'http://203.0.113.9',
    'https://router.example.com',
  ])('refuses the public address %s', async (url) => {
    await expect(load({ ...base, MIKROTIK_URL: url })).rejects.toThrow(
      /not a private address|WireGuard/,
    );
  });

  it('requires credentials when the provider is mikrotik', async () => {
    const { MIKROTIK_PASSWORD: _omit, ...noPassword } = base;
    await expect(
      load({ ...noPassword, MIKROTIK_URL: 'http://10.10.10.2' }),
    ).rejects.toThrow(/MIKROTIK_URL, MIKROTIK_USER and MIKROTIK_PASSWORD/);
  });
});
