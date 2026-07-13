# API Reference

Base URL: `https://<your-domain>`  ·  API prefix: `/v1`

Two authentication modes:

- **Senders** (home automation) use a Bearer API key: `Authorization: Bearer <key>`.
  The key needs the `notify` scope (admin keys work too).
- **PWA users** use a session cookie (`sid`) set by `POST /v1/auth/login`.

All request and response bodies are JSON. Errors have the shape:

```json
{ "error": { "code": "bad_request", "message": "..." } }
```

---

## Sending notifications

### `POST /v1/notify`  (Bearer, scope `notify`)

Enqueues a notification. Returns `202` immediately; routing happens
asynchronously. The topic is created automatically if it does not exist.

```bash
curl -X POST https://notify.example.com/v1/notify \
  -H "Authorization: Bearer $NOTIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "security",
    "priority": "critical",
    "title": "Water leak in kitchen",
    "body": "Leak sensor triggered at 14:32",
    "dedup_key": "leak-kitchen",
    "actions": [
      { "id": "ack", "label": "Acknowledge" },
      { "id": "camera", "label": "View camera", "url": "https://ha.local/camera/kitchen" }
    ]
  }'
```

Fields: `topic` (default `general`), `priority` (`low`|`normal`|`high`|`critical`,
default `normal`), `title` (required), `body`, `dedup_key`, `actions` (max 4),
`media_url`. Response: `{ "message_id": "...", "status": "accepted" }`.

### `POST /v1/homeassistant/notify`  (Bearer, scope `notify`)

Accepts Home Assistant's native notify payload, so HA's built-in **`notify.rest`**
platform can target it directly — giving a real `notify.home_alert` action with no
custom component.

```json
{
  "message": "The kitchen leak sensor triggered",
  "title": "Water leak",
  "target": "security",
  "priority": "critical"
}
```

Mapping: `message` → body, `title` → title, `target` → **topic** (created if it
does not exist; the first entry is used if HA sends a list).

Extras (`priority`, `dedup_key`, `actions`, `media_url`) are accepted **either at
the top level or nested inside `data`**, because HA sends them differently
depending on the route:

- `notify.rest` merges its config-level `data:` block into the payload at the
  **top level**
- `rest_command` and native notify calls **nest** them inside `data`

When a field appears in both, the **nested** value wins: that is the per-call
form, while the top-level one usually comes from static YAML.

See `HOME_ASSISTANT.md` for the full configuration.

---

## Acknowledgement & actions

### `GET /a/:token`

Human-facing confirmation page opened from an SMS link. Marks the matching
delivery acknowledged, which cancels any escalation chain. Single-use and
expiring; returns `410` if already used or expired.

### `POST /v1/ack/:token`

API form of the above. `{ "status": "acknowledged" }` on success, `410` otherwise.

### `POST /v1/messages/:id/ack`  (session)

Acknowledge an **alert**. This is what the Inbox uses.

A critical alert is delivered over web push *and* SMS at the same time — two
`deliveries` rows, but one alert. Acknowledging clears **every channel** the
alert reached that user on, and burns any outstanding SMS ack token, so it never
has to be acknowledged twice.

Scoped to the calling user: another family member's copies stay unacknowledged,
because they have not seen it. Escalation is unaffected by that distinction — the
chain stands down as soon as *anyone* acknowledges.

### `POST /v1/deliveries/:id/ack`  (session)

Acknowledge by delivery id. Used by the service worker, which knows which copy of
the alert it rendered. Behaves identically: acknowledging any copy acknowledges
the whole alert for that user.

### `POST /v1/actions/:messageId/:actionId`  (session)

Trigger a non-ack action button. If the action has a `url`, the server sends it a
**signed** `POST` (HMAC-SHA256) and records the outcome in `action_events`.

- `200` — the receiver accepted it
- `502` — the webhook failed or timed out; the body explains why

The call is not fire-and-forget: an action can unlock a door, so the user is told
whether it actually reached the house. See `HOME_ASSISTANT.md` for the payload,
headers and verification code.

---

## Authentication (PWA)

### `POST /v1/auth/login`

```bash
curl -X POST https://notify.example.com/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "name": "admin", "password": "..." }' -c cookies.txt
```

Returns the **same profile payload as `GET /v1/me`** (id, name, role, sms_number,
subscriptions) plus `session_expires_in_days`. Both are built by the same
function, so a client can use the login response directly without a follow-up
fetch.

Sessions last `SESSION_MAX_AGE_DAYS` (default **400 days** — the longest a browser
will honour) and **slide**: the cookie is re-issued while the app is in use, so an
actively used app never logs you out. The cookie is `HttpOnly`, `Secure` and
`SameSite=Lax`, and is signed with `SESSION_SECRET`.

### `POST /v1/auth/logout`  ·  `GET /v1/me`  (session)

`/v1/me` returns the profile plus the user's topic subscriptions.

### `PATCH /v1/me`  (session)

Edit **your own** profile — no admin required.

```json
{ "sms_number": "+358401234567", "password": "new-password" }
```

Both fields optional; `sms_number` may be `null` to clear it. Changing your
password signs out your *other* devices but keeps the current one. Returns the
updated profile.

### `GET /v1/push/devices` · `DELETE /v1/push/devices/:id`  (session)

The devices you receive push on, and a way to remove ones you no longer use.
Push subscriptions accumulate across reinstalls; dead ones are pruned
automatically, but an old-but-alive device keeps receiving your alerts until you
remove it.

### `POST /v1/auth/logout-all`  (session)

Revokes **every** session the user holds, on every device — for a lost phone.
Implemented by bumping `users.session_version`, which every cookie carries and
every request checks. Changing a password does the same thing, so a password
change actually evicts other devices instead of only appearing to.

---

## Web Push

### `GET /v1/push/vapid-public-key`

Returns `{ "key": "<vapid public key>" }` for the browser to subscribe.

### `POST /v1/push/subscribe`  (session)

```json
{ "endpoint": "https://...", "keys": { "p256dh": "...", "auth": "..." }, "platform": "ios" }
```

### `DELETE /v1/push/subscribe`  (session)

Body `{ "endpoint": "https://..." }`. Removes the subscription.

---

## Topics & subscriptions

Subscriptions are created automatically: a new user is subscribed to every
existing topic, and a newly created topic (including one auto-created by
`/v1/notify`) is subscribed by every existing user, with default preferences
(`min_priority=normal`, `channel_pref=auto`, no quiet hours). Users then narrow
this in Settings. Existing preferences are never overwritten.

### `GET /v1/topics` (session) · `POST /v1/topics` (admin) · `PATCH /v1/topics/:id` (admin) · `DELETE /v1/topics/:id` (admin)

`POST` takes `{ name, dedup_cooldown_seconds? }`. Names are restricted to
lowercase letters, digits, `-` and `_`, because senders address topics by name.

`PATCH` only changes `dedup_cooldown_seconds`. **Renaming is deliberately not
supported:** an automation posts to a *name*, so renaming a topic would leave it
posting the old one — which `/v1/notify` would silently recreate as a fresh topic
that nobody is subscribed to, and the alerts would disappear with no error
anywhere.

`DELETE` removes the topic's subscriptions and escalation rules. Past alerts are
**kept**, detached from the deleted topic — deleting a topic should not erase
your alert history.

### `PUT /v1/subscriptions`  (session)

Set the caller's preferences for a topic.

```json
{
  "topic_id": "uuid",
  "min_priority": "normal",
  "quiet_start": "22:00",
  "quiet_end": "07:00",
  "channel_pref": "auto"
}
```

`channel_pref` is one of `auto`, `push_only`, `sms_only`. `quiet_start`/`quiet_end`
are `"HH:MM"` (24-hour) and may be `null`. They are interpreted in the **server's
local time**, set by the `TZ` environment variable (an IANA tz database name such
as `Europe/Helsinki`). A window may wrap past midnight, e.g. `22:00` → `07:00`.

### `GET /v1/messages?limit=50`  (session)

The caller's notification history (inbox), newest first — **one row per alert**,
not per delivery.

```json
[
  {
    "id": "uuid",
    "title": "Water leak in kitchen",
    "body": "Leak sensor triggered at 14:32",
    "priority": "critical",
    "actions": [{ "id": "camera", "label": "View camera", "url": "..." }],
    "duplicateCount": 0,
    "createdAt": "2026-07-12T14:32:00.000Z",
    "channels": ["webpush", "sms"],
    "acknowledged": false,
    "failed": false
  }
]
```

`channels` lists every channel the alert reached this user on. `acknowledged` is
true once any of them has been acknowledged; `failed` flags an alert where a
channel could not be delivered.

---

## Tenant / household

- `GET /v1/tenant` (session) — `{ id, name }`
- `PATCH /v1/tenant` (admin) — `{ name }`. The initial name comes from
  `TENANT_NAME` in `.env`, but it is editable afterwards without a redeploy.

## Users (admin)

- `GET /v1/users`
- `POST /v1/users` — `{ name, password, sms_number?, role? }`. New users are
  auto-subscribed to every topic.
- `PATCH /v1/users/:id` — `{ sms_number?, role?, password? }`
- `DELETE /v1/users/:id` — their alert history, devices, subscriptions and API
  keys go with them. Two guards: you cannot delete **yourself** (`400`), and you
  cannot delete the **last admin** (`409`). An escalation rule that targeted the
  deleted user survives, falling back to notifying the original recipients.

For a user editing their *own* number or password, see `PATCH /v1/me` — that
needs no admin.

## API keys (self-service)

Keys are **owned by the user who created them**, so anyone can mint and rotate
their own sender token without an admin. Admins additionally see every key in the
tenant, including the ownerless one created by the seed.

- `GET /v1/api-keys` (session) — your keys; all of them if you are an admin
- `POST /v1/api-keys` (session) — `{ name, scopes? }`. Only an admin may request
  the `admin` scope. The plaintext key is returned **once**; only its hash is
  stored.
- `POST /v1/api-keys/:id/rotate` (session) — issues a new secret and invalidates
  the old one immediately, keeping the same id, name and scopes. This is what you
  want when a token may have leaked: the sender is updated in place instead of
  having to create a new key and chase every reference to the old one.
- `DELETE /v1/api-keys/:id` (session) — your own key, or any key if admin

## Escalation rules (admin)

- `GET /v1/escalation-rules`
- `POST /v1/escalation-rules` — `step_order` is **optional**; omit it and the
  step is appended to the end of that topic's chain.
- `PATCH /v1/escalation-rules/:id` — edit a step in place
- `DELETE /v1/escalation-rules/:id`

```json
{
  "topic_id": null,
  "min_priority": "critical",
  "delay_seconds": 180,
  "next_channel": "sms",
  "next_user_id": null,
  "step_order": 1
}
```

`topic_id: null` applies the rule to all topics. `next_user_id: null` re-notifies
the original subscribers. Chain steps run in `step_order`; an acknowledgement on
any delivery cancels the whole chain.

---

## Diagnostics

### `POST /v1/admin/test-sms`  (admin)

Sends a test SMS **straight through the provider**, bypassing the router,
deduplication, quiet hours and escalation. That isolation is deliberate: if this
succeeds the SMS channel works, and any remaining problem is in routing or
subscriptions.

Body is optional; it defaults to the caller's own number.

```bash
curl -X POST https://notify.example.com/v1/admin/test-sms \
  -b cookies.txt -H 'Content-Type: application/json' \
  -d '{ "to": "+358401234567" }'
```

- `200` — `{ status: "sent", to, provider, providerId }`
- `409` — `SMS_PROVIDER=none`, no SMS channel configured
- `502` — the provider failed; the body carries its **actual** error (e.g.
  `RouterOS did not respond within 15000ms — is the WireGuard tunnel up?`)

Also available as a button in Settings → Test the SMS channel. Worth running on
a schedule: a prepaid SIM can expire or run out of credit silently, and a dead
alert channel is this system's worst failure mode.

## Health

### `GET /healthz` → `{ "status": "ok" }`
