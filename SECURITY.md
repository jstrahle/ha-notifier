# Security

## Reporting a vulnerability

Please report privately rather than opening a public issue: use GitHub's
[private vulnerability reporting](https://github.com/jstrahle/ha-notifier/security/advisories/new)
(Security → Report a vulnerability).

Include what you found, how to reproduce it, and what an attacker could do with
it. I will confirm receipt and keep you informed.

## What this software protects

An installation holds the ability to send alerts to a household, and — if
escalation actions are configured — to trigger physical actions in a home. The
threat model is accordingly less about data and more about **trust and control**:
a false alert teaches people to ignore real ones, and a missed alert is the whole
failure mode the system exists to prevent.

## Deployment expectations

Only Caddy should be reachable from the internet, serving `/v1`, `/a` and the
PWA. Everything else must not be:

- **PostgreSQL and Redis** — no published ports; they are reachable only on the
  compose network.
- **The MikroTik management API**, if you use the router as an SMS provider. It
  must be reached over a private tunnel (WireGuard). The server refuses to start
  if `MIKROTIK_URL` points at a public address — that check exists precisely
  because publishing the router's API on its dynamic DNS name is the obvious
  shortcut.
- **`deploy/.env`** holds every secret an installation has: VAPID keys, session
  secret, webhook signing key, database password, SMS credentials. It is
  gitignored. Keep it that way.

## Notes on the design

- **Passwords** use Node's built-in `scrypt`, with a random salt per password.
- **API keys and ack tokens** are stored hashed; the plaintext of a key is shown
  exactly once, at creation.
- **Sessions** are signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookies carrying a
  version that is checked against the database on every request — so a password
  change or "log out all devices" revokes them immediately.
- **Outbound action webhooks** are signed (HMAC-SHA256 over `timestamp.body`) so
  a receiver can verify them. Note that Home Assistant cannot check an HMAC in
  YAML; see `docs/HOME_ASSISTANT.md` for what to do instead, and for why an
  action that unlocks a door should never be marked escalatable.
- **Action webhook URLs are never sent to a client.** A webhook ID is a password;
  the browser has no use for it, and the server makes the outbound call itself.
