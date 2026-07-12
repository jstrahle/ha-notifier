# Home Notification Service (self-hosted)

An API-driven push notification service for home automation. Send notifications
over an HTTP API (or MQTT, or from Home Assistant); the service routes them to
family members with priorities, quiet hours, deduplication, acknowledgement
tracking, and escalation. Normal notifications are delivered via **Web Push** to
an installable **PWA**; **critical** alerts can additionally go out by **SMS** so
they break through silent mode.

This is the open, self-hosted MVP. It is built so a future commercial,
multi-tenant version can branch from it without a rewrite (`tenant_id` is present
throughout; the SMS channel sits behind a provider interface# Home Notification Service

A self-hosted, API-driven notification service for home automation — the piece
that decides **who gets told what, how urgently, and what happens if nobody
responds**.

Send an alert over HTTP (or MQTT, or straight from Home Assistant). The service
routes it to the right people according to priority, quiet hours and per-topic
preferences; suppresses duplicate noise; tracks whether anyone acknowledged it;
and escalates if nobody does. Everyday notifications arrive as **Web Push** in an
installable **PWA**. Genuinely critical ones can additionally go out by **SMS**,
which is the only channel that reliably wakes a silenced phone.

Runs in four containers behind automatic HTTPS. No app store, no cloud account,
no per-seat pricing.

---

## Why this exists

Plenty of self-hosted push tools will deliver a message to a phone. Very few
answer the question that actually matters at 3am:

> The water sensor fired. Everyone's phone is on silent. What now?

This service is built around that question:

- **Priorities and quiet hours** — a door sensor at 2am can wait; a leak cannot.
  Critical alerts bypass quiet hours; everything else respects them.
- **Deduplication *and* aggregation** — a chattering sensor is folded into a
  single notification that then updates itself: *"Repeated 6 times while muted."*
  Suppression alone would simply lose the information.
- **Escalation chains** — nobody acknowledged within N seconds? Escalate to
  another channel, or another person. Any acknowledgement, from anyone, stands
  the whole chain down.
- **Two-way action buttons** — "Close valve", "Silence alarm". The webhook back
  into your automation is HMAC-signed, its outcome is recorded, and a failure is
  reported to the user rather than silently swallowed.
- **A channel that actually breaks through** — see below.

## The critical-alert problem (read this first)

A Progressive Web App **cannot** bypass iOS silent mode or a Focus mode. Neither
can WhatsApp, Signal, or any other third-party app — they are ordinary app
notifications.

The one mechanism that does is **iOS Emergency Bypass**: a setting on a
*contact*, applying to calls and text messages, which overrides both the ringer
switch and Do Not Disturb. It requires the alert to arrive **from a real phone
number** that the recipient has saved as a contact.

That is why SMS is the critical channel here, and why it is not optional if you
want alerts that wake you up. Two ways to get one, both supported:

| | Recurring cost | Notes |
|---|---|---|
| **Your own router's LTE modem** (MikroTik) | none — prepaid SIM, pay per message | Keeps working when your broadband is down. See [`docs/MIKROTIK_SMS.md`](docs/MIKROTIK_SMS.md). |
| **Twilio** | monthly fee per rented number | Quickest to set up; the number fee is the price of the Emergency Bypass capability. |

With no SMS provider configured, a "critical" alert is just a louder web push.
The service says so in its startup log rather than letting you discover it the
hard way.

## Why a PWA rather than a native app

- Installs to the home screen and receives Web Push on **both Android and iOS**
  (iOS 16.4+), with no App Store fee, review, or annual developer subscription.
- On iOS, Web Push only works once the app has been **added to the Home Screen**;
  the onboarding flow detects this and walks the user through it.
- Apple's Critical Alerts entitlement — which *would* let a native app bypass
  silent mode — requires a manual approval process aimed at health and
  public-safety vendors. SMS sidesteps it entirely.

---

## Architecture

```
 Sender (Home Assistant / script / MQTT)
        │  POST /v1/notify
        ▼
   Fastify API ──stores message──▶ PostgreSQL
        │  enqueue
        ▼
   Notification Router  ── dedup + aggregation (Redis) ─┐
   (priority filtering, quiet hours,                    │
    channel selection, escalation)                      ▼
        │                                    BullMQ queues (Redis)
        ├─▶ Web Push worker ──▶ browser push service ──▶ PWA
        └─▶ SMS worker ──▶ MikroTik / Twilio ──▶ phone
                                        (one-tap ack link /a/:token)
```

The **Notification Router** holds all the decision logic and depends only on four
small interfaces — `Store`, `DedupStore`, `Queue`, `Clock`. In production those
are Postgres, Redis and BullMQ; in tests they are in-memory fakes. That is what
makes the routing rules exhaustively testable with no infrastructure at all.

**Stack:** TypeScript · Fastify · PostgreSQL + Drizzle · Redis + BullMQ ·
React + Vite · Caddy (automatic TLS) · Alpine containers.

## Repository layout

```
apps/server    Fastify API, notification router, background workers
apps/pwa       React + Vite PWA (installable, Web Push, hand-written service worker)
deploy         compose.yaml, Caddyfile, .env.example, setup.sh
docs           API.md, HOME_ASSISTANT.md, MIKROTIK_SMS.md
Dockerfile     multi-stage build → one runtime image
INSTALL.md     full deployment walkthrough
```

---

## Quick start

**Requirements:** a Linux host with a public domain name pointing at it, ports 80
and 443 reachable from the internet, and Podman or Docker. Deployment is
documented against Fedora; other distributions differ only in the package manager
and firewall commands.

```bash
git clone <repo-url> notify-service
cd notify-service/deploy

./setup.sh                    # generates VAPID keys + secrets, writes .env
podman-compose up -d --build  # or: docker compose up -d --build
podman-compose exec server node dist/db/seed.js   # migrate, seed, print an API key
```

Open `https://<your-domain>`, sign in as the admin user, then on each phone add
the app to the Home Screen and enable notifications.

[`INSTALL.md`](INSTALL.md) covers the whole process, including timezone
configuration (quiet hours depend on it) and the Emergency Bypass setup that
makes critical alerts actually work.

### Send a notification

```bash
curl -X POST https://<your-domain>/v1/notify \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "security",
    "priority": "critical",
    "title": "Water leak in kitchen",
    "body": "Leak sensor triggered",
    "dedup_key": "leak-kitchen",
    "actions": [
      { "id": "shutoff", "label": "Close valve", "url": "https://ha.local/api/webhook/valve" }
    ]
  }'
```

## Documentation

| | |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Deployment, TLS, timezone, phone setup |
| [`docs/API.md`](docs/API.md) | Every endpoint, with examples |
| [`docs/HOME_ASSISTANT.md`](docs/HOME_ASSISTANT.md) | `rest_command` and notify-compatible integration; how to verify signed action webhooks |
| [`docs/MIKROTIK_SMS.md`](docs/MIKROTIK_SMS.md) | SMS through your own router's LTE modem, over a WireGuard tunnel |

---

## Feature status

Deliberately honest about what is and is not built.

| | |
|---|---|
| Topics, per-user subscriptions, minimum-priority filtering | ✅ |
| Quiet hours, including windows that wrap past midnight | ✅ |
| Acknowledgement — notification button, SMS link, Inbox, iOS deep link | ✅ |
| Escalation chains; any acknowledgement cancels the chain | ✅ with an editor in Settings |
| Deduplication **and** aggregation; per-topic cooldown | ✅ |
| Action buttons — HMAC-signed webhook, outcome recorded and surfaced | ✅ also pressable from the Inbox, since iOS renders no notification buttons |
| Self-service API keys with rotation | ✅ |
| Long-lived sliding sessions, with revocation ("log out all devices") | ✅ |
| Home Assistant, generic webhook, MQTT bridge | ✅ |
| Critical alerts that break through silent mode | ⚠️ **requires SMS** — see above |
| Rich content (camera snapshot in the notification) | ❌ `media_url` is stored but not delivered |
| Presence-based routing (alert whoever is actually home) | ❌ not started |
| Voice-call escalation | ❌ not started; the SMS provider interface would accommodate it |

---

## Development

```bash
# Server — API, router, workers
cd apps/server
npm install
npm run dev          # needs DATABASE_URL and REDIS_URL
npm run typecheck

# PWA
cd apps/pwa
npm install
npm run dev          # proxies /v1 and /a to localhost:3000
npm run icons        # regenerate app icons from icon.svg
```

### Tests

```bash
cd apps/server
npm test                  # unit + router tests — no database, no Redis, no network
npm run test:integration  # additionally runs real SQL:
                          #   TEST_DATABASE_URL=postgres://user@host:5432/db npm run test:integration
```

The default run needs no infrastructure: the router's decision logic runs against
in-memory implementations of its ports, covering priority filtering, quiet hours
(including overnight windows), channel selection, deduplication, aggregation, and
escalation with acknowledgement cancellation.

The integration suite skips itself when `TEST_DATABASE_URL` is unset. It exists
because some behaviour is *only* SQL — the inbox query (`GROUP BY` with
`array_agg` / `bool_or`), the multi-row acknowledgement update, session
revocation — and a type checker proves nothing about any of it.

### Notable design choices

- **No native addons.** Password hashing uses Node's built-in `scrypt`, and SMS
  providers speak HTTP directly rather than through vendor SDKs. That is what
  allows a plain Alpine runtime image with no compiler in it, and keeps the
  dependency tree free of deprecated transitives — both apps install with zero
  deprecation warnings.
- **No Workbox.** The service worker is hand-written. The app is online-first, so
  precaching would pull in `workbox-build` for nothing.
- **Everyone is subscribed by default.** New users are subscribed to every topic
  and new topics to every user. The router only delivers to users who have a
  subscription row, so without this a fresh install would deliver nothing until
  each person happened to save a preference.
- **Every delivery carries an acknowledgement token**, so the service worker can
  acknowledge without a live session — an alert may fire long after the browser
  session lapsed.
- **Acknowledgement is per *alert*, not per delivery.** A critical alert goes out
  by push *and* SMS: two deliveries, one alert. Acknowledging either clears both.
- **Quiet hours use the server's local time.** `TZ` must be an IANA name
  (`Europe/Helsinki`, not `EET` or `+02:00` — an offset cannot express daylight
  saving time). The server validates it at boot and refuses to start on a bad
  value rather than silently falling back to UTC.
- **`tenant_id` is on every table.** The service is single-tenant; the schema
  simply does not have to be rewritten if that ever changes.

## Contributing

Issues and pull requests are welcome.

- Run `npm run typecheck` and `npm test` in `apps/server` before opening a PR.
- Routing behaviour belongs in `apps/server/src/router/` and should come with
  tests against the in-memory ports — no database needed.
- Anything that changes SQL semantics should come with an integration test in
  `apps/server/src/db/__tests__/`.
- Please avoid dependencies that ship native addons or deprecated transitives;
  the runtime image is deliberately compiler-free.

## Security

Only Caddy should be exposed to the internet, serving `/v1`, `/a` and the PWA.
Everything else — PostgreSQL, Redis, and (if you use the MikroTik SMS provider)
the router's management API — must stay unreachable from outside. The server
refuses to start if it is configured to reach a router over a public address.

If you find a vulnerability, please report it privately rather than opening a
public issue.).

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
