# Installation guide

This guide takes you from an empty server to a working notification service with
alerts arriving on your phone. It assumes **no prior knowledge of Podman or
Docker** — every command is explained, and both container tools are covered
equally.

Budget about **45 minutes**, plus DNS propagation time.

**Contents**

1. [What you are about to build](#1-what-you-are-about-to-build)
2. [Prerequisites](#2-prerequisites)
3. [Install a container engine](#3-install-a-container-engine)
4. [Point a domain at the server](#4-point-a-domain-at-the-server)
5. [Open the firewall](#5-open-the-firewall)
6. [Get the code](#6-get-the-code)
7. [Run the setup script](#7-run-the-setup-script)
8. [Build and start](#8-build-and-start)
9. [Create the database contents](#9-create-the-database-contents)
10. [Set up the phones](#10-set-up-the-phones)
11. [Send a test notification](#11-send-a-test-notification)
12. [Make critical alerts wake you (SMS)](#12-make-critical-alerts-wake-you-sms)
13. [Connect Home Assistant](#13-connect-home-assistant-optional)
14. [MQTT bridge](#14-mqtt-bridge-optional)
15. [Backups](#15-backups)
16. [Upgrading](#16-upgrading)
17. [Uninstalling](#17-uninstalling)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. What you are about to build

Four containers, started together by one file (`deploy/compose.yaml`):

| Container | What it does | Exposed to the internet? |
|---|---|---|
| **caddy** | Web server. Gets a free HTTPS certificate automatically and forwards traffic to the app. | **Yes** — ports 80 and 443 |
| **server** | The notification service itself, plus the phone app it serves. | No — only Caddy can reach it |
| **postgres** | Database: users, alerts, delivery history. | No |
| **redis** | Job queue and deduplication timers. | No |

You never start these individually. One command starts all four; one command
stops them.

**HTTPS is not optional.** Web Push refuses to work without it, which is why a
real domain name is required — an IP address alone will not do.

---

## 2. Prerequisites

### A server

Any Linux machine that is **on 24/7** and reachable from the internet:

- a small VPS (1 CPU / 1 GB RAM is enough — this is a low-traffic service), or
- a machine at home, if you can forward ports 80 and 443 to it.

Commands below are shown for **Fedora** (`dnf`) and **Debian/Ubuntu** (`apt`).

> **Note if you host at home:** the alerting chain then depends on your home
> power and internet. A VPS keeps working during a power cut at the house —
> which may be exactly when you want to be told about it.

### A domain name

You need a hostname such as `notify.example.com` that you can point at the
server. If you don't own a domain, a free dynamic-DNS hostname (DuckDNS,
No-IP, and similar) works fine.

### Root or sudo access

All commands below assume you can run `sudo`.

---

## 3. Install a container engine

Pick **one**. If you already have Docker, use Docker — there is no advantage in
switching.

<details open>
<summary><b>Docker</b> (most widely known)</summary>

**Fedora:**
```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
```

**Debian / Ubuntu:**
```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
```

Verify:
```bash
sudo docker compose version     # should print a version number
```
</details>

<details>
<summary><b>Podman</b> (no background daemon, ships with Fedora)</summary>

**Fedora:**
```bash
sudo dnf install -y podman podman-compose
```

**Debian / Ubuntu:**
```bash
sudo apt update
sudo apt install -y podman podman-compose
```

Verify:
```bash
sudo podman-compose version     # should print a version number
```
</details>

### One command for the rest of this guide

The two tools take the same arguments, so set a shell variable now and every
later command works unchanged:

```bash
# Docker:
export COMPOSE="sudo docker compose"

# …or Podman:
export COMPOSE="sudo podman-compose"
```

If you open a new terminal later, run this line again — or just substitute your
own tool wherever you see `$COMPOSE`.

---

## 4. Point a domain at the server

Find the server's public IP address:

```bash
curl -s https://api.ipify.org; echo
```

In your DNS provider's control panel, create an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `notify` (giving `notify.example.com`) | the IP printed above |

Wait for it to take effect, then **confirm it before continuing** — a wrong DNS
record is the single most common reason the HTTPS certificate later fails:

```bash
dig +short notify.example.com
# must print your server's IP address
```

If it prints nothing, wait a few minutes and try again. Do not proceed until this
works.

---

## 5. Open the firewall

Caddy needs ports **80** and **443**. Port 80 is not optional even though the
site is HTTPS — Let's Encrypt uses it to verify that you control the domain.

**Fedora (firewalld):**
```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-services      # should list http and https
```

**Debian / Ubuntu (ufw):**
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

**On a cloud VPS**, also check the provider's own firewall (AWS security groups,
Hetzner firewall, DigitalOcean cloud firewall…). It is separate from the one on
the machine, and it silently blocks traffic.

---

## 6. Get the code

```bash
git clone <repo-url> notify-service
cd notify-service
```

Everything from here happens in the `deploy/` directory:

```bash
cd deploy
ls
# Caddyfile  compose.yaml  setup.sh  .env.example
```

---

## 7. Run the setup script

```bash
./setup.sh
```

It asks a handful of questions and writes a `.env` file containing your
configuration and generated secrets.

| It asks for | What to answer |
|---|---|
| **Public domain** | `notify.example.com` — exactly what you pointed at the server in step 4 |
| **Admin username / password** | Your login for the app. The password is not recoverable, so store it somewhere. |
| **VAPID contact email** | Any address you own. Browser push services use it to contact you if something misbehaves. |
| **Timezone** | See below — this one matters more than it looks |
| **SMS channel** | Choose *3) None* for now. You can enable it in step 12. |

### The timezone question

**Quiet hours are evaluated in the server's local time.** Get this wrong and a
"do not disturb between 22:00 and 07:00" window is silently off by hours.

The format is an **IANA time zone name** — `Area/Location`, case-sensitive:

| | |
|---|---|
| ✅ Correct | `Europe/Helsinki`, `America/New_York`, `Asia/Tokyo`, `UTC` |
| ❌ Rejected | `EET`, `GMT+2`, `+02:00`, `Helsinki` |

Abbreviations and UTC offsets are refused deliberately: an offset cannot express
daylight saving time, so your quiet hours would drift by an hour twice a year.

The script suggests your server's own timezone and validates whatever you type.
To find it yourself:

```bash
timedatectl show --property=Timezone --value
```

The service also validates `TZ` when it starts and **refuses to boot** on an
invalid value, rather than quietly falling back to UTC.

### What the script generated

Have a look — you don't need to edit anything, but it is worth knowing what is
in there:

```bash
grep -v '^#' .env | grep -v '^$'
```

It created your VAPID keys (used to sign push messages), a session secret, a
webhook signing secret and the database password. **`.env` now contains every
secret this service has.** Keep it out of version control and back it up (step
15).

---

## 8. Build and start

```bash
$COMPOSE up -d --build
```

The first run takes several minutes: it downloads the base images and compiles
the app. Later runs are much faster.

**Output that looks alarming but is not:**

- `Trying to pull docker.io/...` and progress bars — first-time image downloads.
- `Resolved "node" as an alias` (Podman) — harmless name expansion.

Progress goes to *stderr*, so `> log.txt` alone will not capture it. Use
`> log.txt 2>&1` if you want a clean transcript.

### Check that everything came up

```bash
$COMPOSE ps
```

You want four containers running, with `server`, `postgres` and `redis` reporting
**healthy**:

```
NAME       STATUS
caddy      Up 2 minutes
postgres   Up 2 minutes (healthy)
redis      Up 2 minutes (healthy)
server     Up 2 minutes (healthy)
```

Then check the service answers:

```bash
curl -s https://notify.example.com/healthz
# {"status":"ok"}
```

If the certificate is not ready yet, give Caddy 30 seconds and retry. If it still
fails, jump to [Troubleshooting](#18-troubleshooting).

Look at the log while you're here:

```bash
$COMPOSE logs server | tail -20
```

You should see `Notification service listening on https://…` and a line telling
you the SMS channel is currently **disabled** — expected, we enable it in step 12.

---

## 9. Create the database contents

The containers are running but the database is empty. This step creates the
tables, your admin user, two default topics, and an API key:

```bash
$COMPOSE exec server node dist/db/seed.js
```

```
Created tenant "Home"
Created admin user "admin"
Created topic "security"
Created topic "general"

=== SAVE THIS API KEY (shown once) ===
xK7fP2mR9tL...
======================================
```

**Copy the API key now.** Only a hash of it is stored, so it cannot be shown
again. It is what Home Assistant and your scripts will use to send alerts. (If
you lose it, you can create a new one in the app under Settings → API keys.)

This command is safe to run again later — it only creates what is missing.

---

## 10. Set up the phones

Do this on every phone that should receive alerts.

### First, create an account for each person

Sign in at `https://notify.example.com` as the admin user you created, then go to
**Settings → Family members → Add a member**. Each person gets their own username
and password.

Everyone is automatically subscribed to every topic — they can narrow that
afterwards in Settings.

### iPhone / iPad

> **This is the step people get wrong.** On iOS, notifications do **not** work in
> Safari. The app must be installed to the Home Screen first.

1. Open `https://notify.example.com` in **Safari** (not Chrome — on iOS only
   Safari can install web apps).
2. Tap the **Share** button (the square with an arrow).
3. Choose **Add to Home Screen**, then **Add**.
4. **Close Safari** and open the app from the new Home Screen icon.
5. Sign in.
6. Tap **Enable notifications** and accept the permission prompt.

The app detects if you skipped step 3 and tells you, rather than letting you
enable notifications that would never arrive.

### Android

1. Open `https://notify.example.com` in Chrome.
2. Accept the "Install app" prompt, or use ⋮ → **Install app**.
3. Sign in, tap **Enable notifications**, accept the prompt.

Installing is recommended but Android will deliver push even from the browser.

---

## 11. Send a test notification

From any machine, using the API key from step 9:

```bash
curl -X POST https://notify.example.com/v1/notify \
  -H "Authorization: Bearer PASTE_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "general",
    "title": "It works",
    "body": "First notification from the server"
  }'
```

```json
{ "message_id": "…", "status": "accepted" }
```

The notification should appear on every phone subscribed to `general`, and in the
app's Inbox.

**Nothing arrived?** See [Troubleshooting](#18-troubleshooting) — but first check
the obvious: is the phone's notification permission actually granted, and (on
iOS) was the app opened from the Home Screen icon rather than Safari?

---

## 12. Make critical alerts wake you (SMS)

**Everything up to here delivers ordinary push notifications. Those cannot wake a
silenced phone.** Not this app's push, not WhatsApp's, not Signal's — they are all
ordinary app notifications, and iOS silences them all.

The only mechanism that gets through is **iOS Emergency Bypass**: a setting on a
*contact* that overrides both the silent switch and Do Not Disturb. It applies to
calls and text messages, so the alert has to arrive **from a real phone number**.

That is why the critical channel is SMS. Two ways to get one:

| | Monthly cost | Guide |
|---|---|---|
| **Your own router's LTE modem** (MikroTik) | none — prepaid SIM, pay per message | [`docs/MIKROTIK_SMS.md`](docs/MIKROTIK_SMS.md) |
| **Twilio** | a fee per rented number | Sign up, buy a number, put the credentials in `.env` |

Set `SMS_PROVIDER` and the matching settings in `deploy/.env`, then:

```bash
$COMPOSE up -d server
$COMPOSE logs server | grep "SMS channel"
# SMS channel ENABLED via …
```

### Then, three things that are easy to forget

**1. Give each person an SMS number.** Settings → Family members. It must be in
international format: `+358401234567`.

**2. Test the channel:** Settings → **Test the SMS channel** → *Send test*. This
sends straight through the provider, skipping all routing, so a failure points at
the SMS setup and nothing else.

**3. Turn on Emergency Bypass on every phone** — without this, the whole exercise
gains you nothing:

- Save the sending number as a **contact** (e.g. "Home Alerts").
- Contacts → that contact → **Edit** → **Text Tone** → enable **Emergency
  Bypass**.

Now silence the phone and send yourself a critical alert:

```bash
curl -X POST https://notify.example.com/v1/notify \
  -H "Authorization: Bearer PASTE_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "topic": "security", "priority": "critical",
        "title": "Test", "body": "This should make a muted phone ring" }'
```

If the muted phone rings, you are done. That is the thing this entire service
exists to do.

### Optional: escalation

Settings → **Escalation chains**. For example: *if a critical alert on any topic
is not acknowledged within 180 seconds, send an SMS to Dad; 300 seconds later,
to Mum.* Any acknowledgement, from anyone, cancels the whole chain.

---

## 13. Connect Home Assistant (optional)

The easiest route: in the app, go to **Settings → Home Assistant → Generate
configuration**. It creates a new API key and prints the complete YAML with your
domain and key already filled in — copy it straight into Home Assistant.

You end up with a real `notify.home_alert` action, exactly like
`notify.pushover`, using Home Assistant's **built-in** RESTful notification
platform. No custom component required.

`secrets.yaml` (the `Bearer ` prefix is part of the value — omit it and you get a
401 with no obvious cause):

```yaml
home_alert_token: "Bearer PASTE_YOUR_API_KEY"
```

`configuration.yaml`:

```yaml
notify:
  - name: home_alert
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    data:
      priority: normal

  - name: home_alert_critical
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    data:
      priority: critical
```

Restart Home Assistant, then use it in an automation:

```yaml
actions:
  - action: notify.home_alert_critical
    data:
      title: "Water leak in kitchen"
      message: "The kitchen leak sensor triggered"
      target: "security"      # the topic
```

Full details, including action buttons and deduplication:
[`docs/HOME_ASSISTANT.md`](docs/HOME_ASSISTANT.md).

## 14. MQTT bridge (optional)

In `deploy/.env`:

```
MQTT_ENABLED=true
MQTT_URL=mqtt://192.168.1.50:1883
MQTT_TOPIC_PREFIX=notify/
```

```bash
$COMPOSE up -d server
```

Publish to `notify/<topic>/<priority>`:

```bash
mosquitto_pub -h 192.168.1.50 -t "notify/security/critical" \
  -m '{ "title": "Alarm", "body": "Motion in the garage" }'
```

A plain-text payload works too — it becomes the body.

---

## 15. Backups

Two things are worth backing up, and they are very different in kind.

**`deploy/.env` — irreplaceable.** It holds your VAPID keys, secrets and database
password. Lose it and every phone must re-subscribe to push. Copy it somewhere
safe (a password manager works):

```bash
cp deploy/.env ~/notify-env-backup
chmod 600 ~/notify-env-backup
```

**The database — useful, not critical.** It holds users, preferences and alert
history. Alerts are transient by nature; the users are the part you would miss.

```bash
$COMPOSE exec postgres pg_dump -U notify notify > notify-backup-$(date +%F).sql
```

Restore:

```bash
cat notify-backup-2026-07-12.sql | $COMPOSE exec -T postgres psql -U notify -d notify
```

---

## 16. Upgrading

```bash
cd notify-service
git pull
cd deploy
$COMPOSE up -d --build
$COMPOSE exec server node dist/db/seed.js   # applies any new schema changes
```

The seed step is **idempotent and additive** — it never drops or overwrites your
data, so it is safe to run on every upgrade. Run it every time; some releases add
database columns and the app will not work correctly without them.

---

## 17. Uninstalling

Stop everything, keeping the data:

```bash
$COMPOSE down
```

Remove the data as well — **this deletes your database permanently**:

```bash
$COMPOSE down -v
```

---

## 18. Troubleshooting

### The site does not load / no HTTPS certificate

```bash
$COMPOSE logs caddy | tail -30
```

In order of likelihood:

1. **DNS is wrong.** `dig +short notify.example.com` must print your server's IP.
2. **Port 80 is blocked.** Let's Encrypt validates over port 80 even though your
   site is HTTPS. Check both the machine's firewall *and* your cloud provider's.
3. **Rate limit.** Let's Encrypt limits repeated failures for the same domain. If
   you have been retrying a lot, wait an hour.

### `$COMPOSE ps` shows a container restarting

```bash
$COMPOSE logs server | tail -40
```

The service validates its configuration at startup and prints a clear reason for
refusing to start. The most common:

- `Invalid TZ value` — not an IANA name. See [step 7](#the-timezone-question).
- `Invalid environment configuration` — a required setting is missing from `.env`.
- `MIKROTIK_URL points at … which is not a private address` — the router must be
  reached over a private/VPN address, never over the internet.

### Push permission granted, but nothing arrives

- **On iPhone: was the app opened from the Home Screen icon?** Notifications do
  not work in Safari itself. This is the most common cause by far.
- Check the alert was actually routed:

  ```bash
  $COMPOSE exec postgres psql -U notify -d notify -c \
    "SELECT d.channel, d.status, d.error, m.title
       FROM deliveries d JOIN messages m ON m.id = d.message_id
      ORDER BY d.queued_at DESC LIMIT 5;"
  ```

  - No rows at all → the alert was not routed to anyone. Check the user is
    subscribed to that topic (Settings) and that the message's priority is at or
    above their minimum.
  - `status = failed` → the `error` column says why.
- Dead push subscriptions (HTTP 410) are pruned automatically; re-enable
  notifications in the app to create a fresh one.

### SMS is not sending

Use Settings → **Test the SMS channel**. It bypasses all routing and reports the
provider's real error, which is far more useful than a delivery row marked
`failed`.

Then check, in order: is `SMS_PROVIDER` set (see the startup log), does the user
have an SMS number in `+358…` format, and does the SIM have credit?

### A critical alert arrives but does not wake the phone

Emergency Bypass is not enabled for that contact — see
[step 12](#12-make-critical-alerts-wake-you-sms). Without it, an SMS is just
another silenced notification.

### Quiet hours trigger at the wrong time

`TZ` in `.env` is wrong or missing. It must be an IANA name such as
`Europe/Helsinki` — never `EET` or `+02:00`. Fix it, then `$COMPOSE up -d server`.

### The app icon on the iPhone is still the old one

iOS caches the Home Screen icon at install time and never refreshes it. Remove the
app from the Home Screen and add it again.

### `HEALTHCHECK is not supported for OCI image format` (Podman)

You are on an old copy of the code. Health checks now live in `compose.yaml`.
`git pull` and rebuild.

### Starting over completely

```bash
$COMPOSE down -v          # deletes the database
$COMPOSE up -d --build
$COMPOSE exec server node dist/db/seed.js
```
