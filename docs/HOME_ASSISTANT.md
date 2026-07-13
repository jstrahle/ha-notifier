# Home Assistant integration

You get a real `notify.home_alert` action — usable from the automation UI exactly
like `notify.pushover` — with **no custom component**. Home Assistant's built-in
[RESTful notification](https://www.home-assistant.io/integrations/notify.rest/)
platform is all it takes.

## The quick way

In the app: **Settings → Home Assistant → Generate configuration**.

It mints a fresh API key and renders the complete YAML with your domain and key
already filled in, ready to paste. That is worth doing rather than typing it by
hand, because the token has to go into `secrets.yaml` **with the word `Bearer `
as part of the value** — leave it out and every call fails with a 401 and no
useful clue as to why.

The rest of this page explains what that configuration does, and how to go
further.

---

## 1. Notifications (`notify.rest`)

`secrets.yaml`:

```yaml
# The "Bearer " prefix is part of the value.
home_alert_token: "Bearer YOUR_API_KEY"
```

`configuration.yaml`:

```yaml
notify:
  # Everyday alerts: web push only.
  - name: home_alert
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    data:
      priority: normal

  # Critical alerts: web push AND SMS in parallel, bypassing quiet hours.
  - name: home_alert_critical
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    data:
      priority: critical
```

Restart Home Assistant. You now have two actions.

```yaml
automation:
  - alias: "Water leak in the kitchen"
    triggers:
      - trigger: state
        entity_id: binary_sensor.kitchen_leak
        to: "on"
    actions:
      - action: notify.home_alert_critical
        data:
          title: "Water leak in kitchen"
          message: "The kitchen leak sensor triggered"
          target: "security"
```

### How the fields map

| Home Assistant | Here |
|---|---|
| `message` | the alert body |
| `title` | the alert title (defaults to "Home Assistant") |
| `target` | the **topic** — created automatically if it does not exist |
| `priority` (from the notifier's `data:` block) | `low` \| `normal` \| `high` \| `critical` |

### Why one notifier per priority

`notify.rest`'s `data:` block is **configuration-level**, not per-call: you
cannot pass a different priority from each automation through a single notifier.
Defining one notifier per priority works around that, and reads better anyway —
`notify.home_alert_critical` says plainly what it does at the call site.

Add `home_alert_high` and `home_alert_low` the same way if you want them.

---

## 2. Deduplication for noisy sensors

Pass a stable `dedup_key` and repeats inside the cooldown window are suppressed,
counted, and then folded back into the original notification when the window
closes (*"Repeated 6 times while muted."*). The push reuses the same tag, so it
replaces the existing notification rather than stacking another one.

`notify.rest` can only send a fixed `dedup_key` per notifier, so for a per-sensor
key use a `rest_command` instead (below). Critical alerts are never suppressed.

The window defaults to `DEDUP_COOLDOWN_SECONDS` and can be set per topic in
Settings → Topics.

---

## 3. `rest_command` — when you need per-call control

Use this when a single automation needs to vary the priority, the dedup key, or
the action buttons. It is more flexible than `notify.rest` and more verbose.

```yaml
rest_command:
  home_notify:
    url: "https://notify.example.com/v1/notify"
    method: POST
    headers:
      Authorization: !secret home_alert_token
      Content-Type: "application/json"
    payload: >
      {
        "topic": "{{ topic | default('general') }}",
        "priority": "{{ priority | default('normal') }}",
        "title": "{{ title }}",
        "body": "{{ message }}",
        "dedup_key": "{{ dedup_key | default('') }}"
      }
```

```yaml
actions:
  - action: rest_command.home_notify
    data:
      topic: "security"
      priority: "critical"
      title: "Water leak in kitchen"
      message: "The kitchen leak sensor triggered"
      dedup_key: "leak-kitchen"
```

---

## 4. Action buttons (two-way)

An alert can carry buttons — "Close valve", "Silence alarm" — that call back into
Home Assistant when pressed.

```bash
curl -X POST https://notify.example.com/v1/notify \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "security",
    "priority": "high",
    "title": "Someone at the door",
    "body": "Motion at the front door",
    "actions": [
      { "id": "unlock", "label": "Unlock",
        "url": "https://ha.example.com/api/webhook/YOUR_SECRET_WEBHOOK_ID" }
    ]
  }'
```

Receive it with a webhook trigger:

```yaml
automation:
  - alias: "Unlock from an alert"
    triggers:
      - trigger: webhook
        webhook_id: YOUR_SECRET_WEBHOOK_ID
        allowed_methods: [POST]
        local_only: false          # required: the call comes from the internet
    actions:
      - action: lock.unlock
        target:
          entity_id: lock.front_door
```

The payload is available as `trigger.json`:

```json
{
  "message_id": "uuid",
  "action_id": "unlock",
  "user_id": "uuid",
  "user_name": "matti",
  "topic": "security",
  "priority": "high",
  "title": "Someone at the door",
  "triggered_at": "2026-07-13T09:41:00.000Z"
}
```

### Read this before wiring a button to a lock

Home Assistant's own documentation says, plainly: **do not use a webhook to
unlock a lock or open a garage door.** Webhook endpoints have no authentication
beyond knowledge of the webhook ID.

That warning is correct, and it is exactly why this service **signs** every action
webhook:

| Header | Meaning |
|---|---|
| `X-Notify-Signature` | `sha256=<hex>` — HMAC-SHA256 of `${timestamp}.${rawBody}` |
| `X-Notify-Timestamp` | Unix seconds, so replays can be rejected |

The signing key is `WEBHOOK_SIGNING_SECRET` from `.env` (falling back to
`SESSION_SECRET`).

**Home Assistant cannot verify an HMAC in YAML.** Templates have no HMAC
function, so verifying the signature needs Python — `pyscript`, AppDaemon, or a
custom integration. So, pragmatically:

- **Non-destructive actions** (silence an alarm, acknowledge, run a scene): the
  secrecy of the webhook ID is adequate. Use the automation above as-is.
- **Destructive or safety-relevant actions** (locks, doors, valves): either
  verify the signature properly, or gate the automation behind something else —
  a `condition` on presence, a confirmation, or a second factor. A secret URL
  alone is not enough for a front door, and this service signing the request does
  not help if the receiving end never checks.

Verification, for a receiver that can run Python:

```python
import hashlib, hmac, time

def verify(raw_body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:      # reject replays
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

A custom Home Assistant integration that verifies the signature and fires an
ordinary HA event is on the roadmap; it would make this a non-issue.

### iOS note

Safari does not render notification action buttons at all. iPhone users press the
same buttons in the app's Inbox instead, and the result — including a failed
webhook — is reported back to them. A button that silently does nothing is worse
than no button.

---

## 5. MQTT

If you would rather not call an HTTP API at all, enable the MQTT bridge
(`MQTT_ENABLED=true`) and publish to `notify/<topic>/<priority>`:

```yaml
actions:
  - action: mqtt.publish
    data:
      topic: "notify/security/critical"
      payload: >
        { "title": "Water leak", "body": "Kitchen sensor triggered" }
```

A plain-text payload works too; it becomes the body.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 Unauthorized` | The `Bearer ` prefix is missing from the secret's value, or the key was revoked. Regenerate under Settings → Home Assistant. |
| Alert accepted (`202`) but nobody receives it | Nobody is subscribed to that topic, or their minimum priority is above the message's. Check Settings → Topic preferences. |
| `notify.home_alert` does not appear | Home Assistant was not restarted, or the `notify:` block has a YAML error. Check **Developer tools → Actions**. |
| Critical alert arrives but does not wake the phone | Emergency Bypass is not enabled for the sending number. See `INSTALL.md` step 12. |
| Webhook automation never fires | `local_only: false` is missing — the call arrives from the internet, not your LAN. |
