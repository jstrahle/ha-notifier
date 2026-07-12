# Installation

A step-by-step guide to running the self-hosted notification service with Podman
(Docker works too — the compose file is compatible).

## 1. Prerequisites

- A Linux host (a small VPS or a home server) with a **public domain name**
  pointing to it. These instructions were written against **Fedora 44**
  (firewalld, SELinux enforcing, Podman); other distributions work, only the
  package-manager and firewall commands differ. HTTPS is mandatory for Web Push, and the domain is needed for
  Caddy to obtain a TLS certificate.
- Ports **80** and **443** reachable from the internet (Let's Encrypt validation).
  On Fedora:

  ```bash
  sudo firewall-cmd --permanent --add-service=http --add-service=https
  sudo firewall-cmd --reload
  ```
- **Podman** + **podman-compose** (or Docker + Docker Compose).
- **Node.js** available on the host — only for `setup.sh`, which generates VAPID
  keys. (Alternatively generate them inside a container; see step 3 notes.)
- All container images are **Alpine**-based; the server image needs no build
  toolchain because it has no native dependencies.
- Optional but strongly recommended: an **SMS channel** for critical alerts —
  either your own MikroTik router's LTE modem (no monthly fee, see
  `docs/MIKROTIK_SMS.md`) or a **Twilio** account. Without SMS, a critical alert
  cannot break through a silenced iPhone.

DNS: create an `A`/`AAAA` record, e.g. `notify.example.com`, pointing to the
host's public IP. Confirm it resolves before continuing.

## 2. Get the code

```bash
git clone <your-repo-url> notify-service
cd notify-service
```

## 3. Run setup

```bash
cd deploy
./setup.sh
```

This will:

- prompt for your domain, admin username/password, VAPID contact email,
  **timezone**, and optional Twilio credentials;
- generate the VAPID key pair (Web Push), the session secret, and the Postgres
  password;
- write a locked-down `deploy/.env`.

If Node.js is not installed on the host, generate VAPID keys another way and edit
`.env` manually — `npx web-push generate-vapid-keys --json` prints them.

## 4. Build and start

```bash
podman-compose up -d --build      # or: docker compose up -d --build
```

Four containers start: `caddy`, `server`, `postgres`, `redis`. Caddy will obtain
a TLS certificate on first request (this can take a few seconds).

Check the services. All four should be `Up`, and `server`, `postgres` and
`redis` should report `(healthy)`:

```bash
podman-compose ps
podman-compose logs server        # should end with "listening on https://..."
curl -s https://<your-domain>/healthz     # -> {"status":"ok"}
```

### Warnings you can ignore during the build

Podman prints a few things that look alarming but are not errors:

- `Trying to pull docker.io/library/...` and blob copy progress — this is just
  the first-time image download.
- `Resolved "node" as an alias` — Podman expanding the short name in the
  Dockerfile's `FROM node:22-alpine`. Harmless.

If the build finishes and `podman-compose ps` shows the containers up, the build
succeeded. Note that `podman-compose up -d --build` writes progress to **stderr**,
so redirecting only stdout (`>> logs.txt`) still prints all of the above to your
terminal — capture both with `>> logs.txt 2>&1` if you want a clean run.

## 5. Initialise the database

Run the migration + seed once. It creates the tenant, the admin user, the
default topics (`security`, `general`), and prints an API key.

```bash
podman-compose exec server node dist/db/seed.js
```

**Copy the printed API key now — it is shown only once.** It is used by senders
(Home Assistant, scripts) in the `Authorization: Bearer <key>` header.

## 6. Set up your phone (the important part)

On each phone:

1. Open `https://<your-domain>` in the mobile browser.
2. Sign in with a user account (create members in the app under
   Settings → Users, as admin).
3. **iPhone/iPad:** tap **Share → Add to Home Screen**, then open the app from
   the new Home Screen icon. Web Push does **not** work until the app runs from
   the Home Screen.
4. Open the app and tap **Enable notifications**, then accept the permission
   prompt.

**Android:** you can enable notifications directly in the browser or after
installing; the flow is the same minus the Home Screen requirement.

## 6b. Set the timezone (required for quiet hours)

Quiet hours are evaluated in the **server's local time**, which comes from the
`TZ` variable in `deploy/.env`. `setup.sh` prompts for this and validates it.

**Format: an IANA tz database name**, written as `Area/Location` and
case-sensitive.

| | |
|---|---|
| ✅ Valid | `Europe/Helsinki`, `Europe/Stockholm`, `America/New_York`, `Asia/Tokyo`, `UTC`, `Etc/UTC` |
| ❌ Invalid | `EET`, `GMT+2`, `+02:00`, `Helsinki`, `europe/helsinki` |

Abbreviations and UTC offsets are rejected on purpose: an offset cannot express
daylight saving time, so a quiet window of 22:00–07:00 would silently drift by
an hour twice a year.

Find your zone on the host:

```bash
timedatectl show --property=Timezone --value   # e.g. Europe/Helsinki
timedatectl list-timezones                     # full list
```

The full list is also at
<https://en.wikipedia.org/wiki/List_of_tz_database_time_zones> (use the "TZ
identifier" column).

To change it later, edit `TZ` in `deploy/.env` and recreate the server:

```bash
podman-compose up -d server
```

If `TZ` is missing or invalid the server **refuses to start** with an explanatory
error, rather than quietly falling back to UTC and getting quiet hours wrong.

## 7. Send a test notification

```bash
curl -X POST https://<your-domain>/v1/notify \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "topic": "general", "title": "Test", "body": "Hello from setup" }'
```

The notification should appear on any device that subscribed to `general`.

## 8. Wire up Home Assistant (optional)

See `docs/HOME_ASSISTANT.md` for `rest_command` and notify-compatible examples.

## 9. Enable SMS for critical alerts (optional)

If you enabled Twilio in setup, add each user's phone number (E.164, e.g.
`+358401234567`) under Settings → Users. Critical messages then go to Web Push
**and** SMS in parallel. To make a topic escalate to SMS after a delay if nobody
acknowledges, add an escalation rule (Settings → Escalation, or
`POST /v1/escalation-rules`).

## 10. Enable MQTT (optional)

Set in `.env`:

```
MQTT_ENABLED=true
MQTT_URL=mqtt://<broker-host>:1883
MQTT_TOPIC_PREFIX=notify/
```

Publish to `notify/<topic>/<priority>`, for example:

```bash
mosquitto_pub -h <broker> -t "notify/security/critical" \
  -m '{ "title": "Alarm", "body": "Motion in garage" }'
```

Recreate the `server` container after changing `.env`:
`podman-compose up -d server`.

## Upgrading

```bash
git pull
podman-compose up -d --build
podman-compose exec server node dist/db/seed.js   # migrations are idempotent
```

The seed/migration step is safe to re-run: it uses `CREATE ... IF NOT EXISTS`
and only creates the admin/API key if none exist.

## Troubleshooting

- **No TLS certificate / site not loading:** confirm DNS points to the host and
  ports 80/443 are open. Check `podman-compose logs caddy`.
- **Push permission granted but nothing arrives:** on iOS, confirm the app was
  opened from the Home Screen icon (not Safari). Check `podman-compose logs
  server` for Web Push errors; dead subscriptions (HTTP 410) are pruned
  automatically.
- **SMS not sending:** confirm `SMS_PROVIDER=twilio` and the Twilio credentials,
  and that the recipient has an E.164 `sms_number`.
- **Database connection errors on boot:** the server waits for Postgres health;
  check `podman-compose logs postgres`.
- **`HEALTHCHECK is not supported for OCI image format`:** you are on an older
  copy of the Dockerfile. Health checks are now declared in `compose.yaml`
  (Podman builds OCI images and ignores the Dockerfile's `HEALTHCHECK`, which
  would leave the server unmonitored). Pull the latest and rebuild.
- **`npm warn using --force` / `npm notice New major version of npm`:** likewise
  fixed in the current Dockerfile; both were build-time noise, not failures.
- **Quiet hours trigger at the wrong time:** they are evaluated in the server's
  local time. Set `TZ` in `.env` to an IANA name (e.g. `TZ=Europe/Helsinki` —
  not `EET` or `+02:00`; see step 6b) and recreate the server container.
- **Server exits on boot with "Invalid TZ value":** `TZ` is not an IANA tz
  database name. See step 6b for the accepted format.
- **Changed the app icon but the iPhone still shows the old one:** iOS caches the
  Home Screen icon at install time. Remove the app from the Home Screen and add
  it again. Rebuilding and reloading the page is not enough.
- **A user receives nothing:** confirm they have a subscription row for the
  topic (Settings → the topic should be listed). New users and new topics are
  auto-subscribed; if you created data before upgrading, re-run the seed step —
  it backfills missing subscriptions and is safe to repeat.
