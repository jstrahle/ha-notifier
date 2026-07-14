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
    message_param_name: message
    title_param_name: title
    target_param_name: target
    data:
      priority: normal

  # Critical alerts: web push AND SMS in parallel, bypassing quiet hours.
  - name: home_alert_critical
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    message_param_name: message
    title_param_name: title
    target_param_name: target
    data:
      priority: critical
```

> ### Do not omit the three `*_param_name` lines
>
> With `method: POST_JSON`, Home Assistant **does not send `title` or `target`
> unless you name them here**. Leave them out and every alert arrives titled
> *"Home Assistant"* and lands in the *general* topic — no matter what your
> automation passes. The call still succeeds, so nothing looks broken; the fields
> simply never leave Home Assistant.

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

## 4b. Escalating to an action — closing the valve nobody came to close

An escalation step does not have to be another person. It can be **the alert's
own action**, run automatically because nobody responded.

```
🔒 security — critical
   1. immediately   → push to everyone
   2. +3 min        → SMS to Jari
   3. +5 min        → SMS to Liisa
   4. +10 min       → ⚙️ run the alert's action, SMS the result to Jari
   5. +15 min       → SMS to the neighbour
```

### The sender decides what is safe to automate

Escalation rules are per topic; a valve is per alert. That tension resolves
itself, because the alert already carries its own actions. Mark the ones that may
run unattended:

```json
"actions": [
  { "id": "shutoff", "label": "Close valve",
    "url": "https://ha.example.com/api/webhook/SECRET", "escalate": true },
  { "id": "plumber", "label": "Call the plumber",
    "url": "https://ha.example.com/api/webhook/OTHER" }
]
```

The escalation rule never names an action. It says only *"run this alert's
escalatable actions"*. So the automation that raises a kitchen-leak alert decides
that closing the valve is safe to do unattended, while calling the plumber is
not — and a door sensor's alert, in the same topic, offers nothing to run at all.

Two opt-ins are required, and both are yours: the rule must ask for an action
step, **and** the sender must have marked that action on that alert.

### ⚠️ Only ever automate actions that reach a SAFE state

| Reasonable | Never |
|---|---|
| Close a water valve | Unlock a door |
| Cut power to an appliance | Open a garage |
| Silence a siren | Disarm an alarm |
| Turn off a heater | Turn off heating in winter |

Nothing in the software can enforce this. The system is deciding to act because
**nobody answered their phone** — which is not evidence that acting is safe, only
that nobody stopped it. Choose actions whose worst outcome is inconvenience.

Home Assistant's own documentation already warns against wiring webhooks to
locks. An unattended call is a stronger reason to heed it, not a weaker one.

### What happens when it runs

1. **Acknowledgement cancels it.** If anyone acknowledged the alert — from the
   notification, the SMS link or the Inbox — the chain stops and the action never
   runs. A human dealt with it; the valve is theirs to close.
2. **It runs at most once.** The claim is enforced by a unique index in the
   database, so a retried queue job or two workers racing cannot close the valve
   twice.
3. **Everyone is told.** A push goes to every subscriber, and an SMS to the person
   named on the step. This is not optional: someone who comes home to find the
   water off, with no explanation, stops trusting the system — and trust is the
   only reason anyone gets up at 3am for it.
4. **A failure is louder than a success.** If the webhook fails, the report goes
   out as **critical**: *"Close valve FAILED (Receiver returned 500). Nobody
   acknowledged 'Water leak in kitchen'. Deal with it yourself."* A valve that did
   not close is worse than one nobody tried to close, because now you think it is
   handled.
5. **The report never escalates.** It cannot start a chain of its own, or
   reporting "valve closed" would close the valve again, report again, for ever.

### Telling a human press from an automatic one

The webhook payload carries `triggered_by`:

```json
{
  "action_id": "shutoff",
  "triggered_by": "escalation",
  "user_id": null,
  "user_name": null,
  "title": "Water leak in kitchen",
  "triggered_at": "2026-07-14T03:12:00.000Z"
}
```

`triggered_by: "user"` means somebody pressed the button. `"escalation"` means
nobody did. Home Assistant may reasonably want to log the second more loudly.

### Setting it up

1. In the app: **Settings → Escalation chains → the topic → + Add step**, and
   choose **run the alert's action**. Pick who is told the outcome by SMS.
2. In Home Assistant, add `"escalate": true` to the action on the alerts where it
   is safe.

### Sending an alert with buttons, from an ordinary notifier

You do **not** need a `rest_command`, and you do not need a notifier per alert
type. Keep the notifiers you already have — one per priority — and let each
automation supply its own buttons.

The trick is `data_template:`, which Home Assistant renders against the service
call's own arguments. Add one line to each notifier:

```yaml
notify:
  - name: home_alert
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    message_param_name: message
    title_param_name: title
    target_param_name: target
    data:
      priority: normal
    data_template:
      # Buttons come from the automation's own data: field.
      actions: "{{ (data | default({})).get('actions', []) | to_json }}"

  - name: home_alert_critical
    platform: rest
    resource: https://notify.example.com/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    message_param_name: message
    title_param_name: title
    target_param_name: target
    data:
      priority: critical
    data_template:
      actions: "{{ (data | default({})).get('actions', []) | to_json }}"
```

Now any automation can attach buttons to any alert:

```yaml
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
        data:
          actions:
            - id: shutoff
              label: "Close valve"
              url: "http://192.168.88.50:8123/api/webhook/YOUR-SECRET-ID"
              escalate: true          # the escalation may run this unattended
            - id: plumber
              label: "Call the plumber"
              url: "http://192.168.88.50:8123/api/webhook/ANOTHER-ID"
                                      # no escalate: a human may press it, the system may not
```

An automation with nothing to automate simply omits `data:` and gets a plain
alert. The notifiers stay generic; the buttons belong to the alert.

> **Why the value is a string.** `notify.rest` renders `data_template:` with
> `parse_result=False`, so `to_json` is required and the result reaches the wire
> as a JSON *string*, not an array. The server accepts both, so this just works —
> but it is why the template needs `| to_json` and not bare `{{ data.actions }}`,
> which would render Python-style quotes and be rejected.

### The `rest_command` alternative

Only needed if you want to bypass the notify platform entirely:

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
| **Every alert is titled "Home Assistant"** | `title_param_name: title` is missing from the notifier. With `POST_JSON`, HA does not send the title unless it is named. |
| **Every alert lands in the `general` topic** | `target_param_name: target` is missing, for the same reason. |
| Critical alert arrives but does not wake the phone | Emergency Bypass is not enabled for the sending number. See `INSTALL.md` step 12. |
| **The SMS arrives immediately, not after the escalation delay** | The recipient's channel is *"Push + SMS at once"*, so the router texts them at t=0 — before any escalation begins. Set their channel to *"Push first — SMS only if escalated"* in Settings → Topic preferences. |
| Webhook automation never fires | `local_only: false` is missing — the call arrives from the internet, not your LAN. |
