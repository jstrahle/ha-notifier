# Home Notification Service (self-hosted)

An API-driven push notification service for home automation. Send notifications
over an HTTP API (or MQTT, or from Home Assistant); the service routes them to
family members with priorities, quiet hours, deduplication, acknowledgement
tracking, and escalation. Normal notifications are delivered via **Web Push** to
an installable **PWA**; **critical** alerts can additionally go out by **SMS** so
they break through silent mode.

This is the open, self-hosted MVP. It is built so a future commercial,
multi-tenant version can branch from it without a rewrite (`tenant_id` is present
throughout; the SMS channel sits behind a provider interface).

## Why a PWA + SMS (not a native app)

- A PWA installs to the home screen and receives Web Push on both Android and
  iOS (iOS 16.4+), with **no App Store fee or review**.
- iOS Web Push requires the app to be **added to the Home Screen** first — the
  onboarding flow guides users through this.
- iOS does not let web push bypass silent/Focus mode, so genuinely critical
  alerts use **SMS** as the channel that reliably breaks through. This avoids the
  hard-to-obtain Apple Critical Alerts entitlement.

## Architecture

```
 Sender (HA / script / MQTT)
        │  POST /v1/notify
        ▼
   Fastify API ──stores message──▶ PostgreSQL
        │  enqueue
        ▼
   Notification Router  ── dedup (Redis) ─┐
   (priorities, quiet hours,              │
    channel selection, escalation)        ▼
        │                          BullMQ queues (Redis)
        ├─▶ Web Push worker ──▶ browser push services ──▶ PWA
        └─▶ SMS worker ──▶ Twilio ──▶ phone
                                   (ack link /a/:token)
```

The **Notification Router** is the core. It is written against small interfaces
(`Store`, `DedupStore`, `Queue`, `Clock`) so its decision logic is exercised by
an in-memory test suite as well as the real Postgres/Redis adapters.

## Repository layout

```
apps/server   Fastify API + router + workers (one image)
apps/pwa      React + Vite PWA (installable, Web Push)
deploy        compose.yaml, Caddyfile, .env.example, setup.sh
docs          API.md, HOME_ASSISTANT.md, MIKROTIK_SMS.md
Dockerfile    multi-stage build (PWA + server -> one runtime image)
```

## Quick start

See `INSTALL.md` for the full walkthrough. In short:

```bash
cd deploy
./setup.sh                       # generates secrets + VAPID keys, writes .env
podman-compose up -d --build     # or: docker compose up -d --build
podman-compose exec server node dist/db/seed.js   # migrate + seed, prints API key
```

Then open `https://<your-domain>`, sign in as the admin user, and on a phone add
the app to the Home Screen and enable notifications.

## Sending your first notification

```bash
curl -X POST https://<your-domain>/v1/notify \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "topic": "general", "title": "Hello", "body": "It works" }'
```

## Development

```bash
# Server
cd apps/server
npm install
npm test          # router unit + integration tests (no DB/Redis needed)
npm run typecheck
npm run dev       # needs DATABASE_URL + REDIS_URL

# PWA
cd apps/pwa
npm install
npm run dev       # proxies /v1 and /a to localhost:3000
npm run build
```

## Notable design choices

- **No native addons.** Passwords use Node's built-in `scrypt` (not argon2) and
  SMS talks to Twilio's REST API over `fetch` (not the SDK). This is what lets
  the runtime image be plain Alpine with no compiler, and keeps the dependency
  tree free of deprecated transitive packages.
- **No Workbox.** The service worker is hand-written; the app is online-first,
  so precaching would add `workbox-build` (and its deprecated deps) for nothing.
- **Everyone is subscribed by default.** New users are subscribed to every
  topic, and new topics to every user. The router only delivers to users with a
  subscription row, so without this a fresh install would deliver nothing until
  each person manually saved a preference.
- **Every delivery carries an ack token.** The service worker acknowledges via
  the session-free `POST /v1/ack/:token`, so an Acknowledge button still works
  when the browser session has expired.
- **Quiet hours use the server's local time.** Set `TZ` in `.env` to an IANA tz
  database name (`Europe/Helsinki`, not `EET` or `+02:00`) — offsets cannot
  express daylight saving time. The server validates `TZ` on boot and refuses to
  start on an invalid value rather than silently falling back to UTC. See
  `INSTALL.md` step 6b.

## Feature status

| Feature | State |
|---|---|
| Topics, per-user subscriptions, min-priority filtering | Done |
| Quiet hours (incl. overnight windows) | Done |
| Acknowledgement tracking (push button, SMS link, Inbox, iOS deep link) | Done |
| Escalation chains — any ack cancels the whole chain | Done, with an editor in Settings |
| Deduplication **and aggregation** ("Repeated 6 times while muted"), per-topic cooldown | Done |
| Action buttons — HMAC-signed webhook, outcome recorded and reported | Done; pressable from the Inbox because iOS renders no notification buttons |
| Self-service API keys with rotation | Done |
| Critical alerts that break through silent mode | **Requires SMS.** Two providers: your own **MikroTik** router's LTE modem (no monthly fee — see `docs/MIKROTIK_SMS.md`) or **Twilio**. Without SMS a critical alert is just a louder web push: iOS does not let a PWA — or WhatsApp, or Signal — bypass silent/Focus mode. Only an SMS from a contact with **Emergency Bypass** does. |
| Rich content (camera images) | Not implemented (`media_url` is stored but not delivered) |
| Presence-based routing | Not implemented |

## Changing the app icon

The icon lives in `apps/pwa/icon.svg`. Edit it (keep the 512x512 viewBox), then:

```bash
cd apps/pwa
npm run icons      # regenerates public/icons/180.png, 192.png, 512.png
```

Prefer your own artwork? Drop a square PNG at `apps/pwa/icon.png` — the script
uses it in preference to the SVG. Then rebuild and redeploy:

```bash
cd deploy && podman-compose up -d --build
```

**On iPhone, that is not enough.** iOS caches the Home Screen icon at install
time and will not refresh it. You must **remove the app from the Home Screen and
add it again** (Share → Add to Home Screen). Push subscriptions survive this, but
if notifications stop working afterwards, just re-enable them in the app.

The label under the icon comes from `apple-mobile-web-app-title` in
`apps/pwa/index.html` (currently "Home"); the manifest's `short_name` is what
Android uses.

Two iOS quirks the generator already handles for you, and which are easy to trip
over if you export icons by hand:

- **No transparency.** iOS composites a transparent Home Screen icon onto black,
  which reads as a rendering bug. Every generated icon is flattened onto an
  opaque background.
- **No pre-rounded corners.** iOS rounds them itself; a pre-rounded source ends
  up double-rounded with dark corners. The source art is deliberately full-bleed
  and square.

## Running the tests

```bash
cd apps/server
npm test                 # unit + router tests, no infrastructure needed
npm run test:integration # additionally exercises real SQL — needs a database:
                         #   TEST_DATABASE_URL=postgres://user@host:5432/db npm run test:integration
```

The integration suite skips itself when `TEST_DATABASE_URL` is unset, so the
default run stays dependency-free. It exists because the inbox query
(`GROUP BY` + `array_agg` + `bool_or`) and the acknowledgement UPDATE are SQL
behaviour, and the type checker proves nothing about those.

## Validation status

- `apps/server`: clean install with **zero deprecation warnings**; full
  TypeScript typecheck passes; **80 tests pass** (74 without a database, plus 6
  integration tests run against a real PostgreSQL 16) — priority filtering, quiet
  hours (incl. overnight windows), channel selection (including the no-SMS-
  provider case), deduplication, critical bypass, the escalation chain with
  ack-cancellation, and scrypt password hashing. All runnable without Postgres
  or Redis.
- `apps/pwa`: clean install with **zero deprecation warnings**; typecheck
  passes; production build emits the app, the static manifest and a real service
  worker (`push` + `notificationclick` listeners verified in the output).

Integration against live Postgres/Redis/Twilio and the end-to-end push flow on a
real device are the remaining manual checks — see `INSTALL.md`.

## Configuration

All configuration is via environment variables, validated on boot. See
`deploy/.env.example` for the full list with comments.

## License

Choose a license before publishing (MIT is a common choice for self-hosted
tools). Add a `LICENSE` file at the repo root.
