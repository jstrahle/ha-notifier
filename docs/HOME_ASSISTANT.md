# Home Assistant integration

There are two ways to send notifications from Home Assistant. Both use a Bearer
API key with the `notify` scope (create one in the app under Settings → API keys,
or use the key printed by the seed step).

Store the key as a secret in `secrets.yaml`:

```yaml
notify_api_key: "YOUR_API_KEY"
```

---

## Option A — `rest_command` (simplest)

Add to `configuration.yaml`:

```yaml
rest_command:
  home_notify:
    url: "https://notify.example.com/v1/notify"
    method: POST
    headers:
      Authorization: !secret notify_api_key_header
      Content-Type: "application/json"
    payload: >
      {
        "topic": "{{ topic | default('general') }}",
        "priority": "{{ priority | default('normal') }}",
        "title": "{{ title }}",
        "body": "{{ message }}"
      }
```

Because the header needs the `Bearer ` prefix, store it whole:

```yaml
# secrets.yaml
notify_api_key_header: "Bearer YOUR_API_KEY"
```

Use it in an automation:

```yaml
automation:
  - alias: "Notify on water leak"
    trigger:
      - platform: state
        entity_id: binary_sensor.kitchen_leak
        to: "on"
    action:
      - service: rest_command.home_notify
        data:
          topic: "security"
          priority: "critical"
          title: "Water leak in kitchen"
          message: "The kitchen leak sensor just triggered."
```

---

## Option B — notify-compatible endpoint

The server exposes `POST /v1/homeassistant/notify`, which accepts Home
Assistant's native notify payload (`message`, `title`, `target`, `data`) and maps
it to an internal notification:

- `target` → topic name (first value if a list)
- `data.priority` → priority (`low`|`normal`|`high`|`critical`)
- `data.dedup_key` → deduplication key

You can wire this to a `rest_command` and call it like a notifier:

```yaml
rest_command:
  home_notify_ha:
    url: "https://notify.example.com/v1/homeassistant/notify"
    method: POST
    headers:
      Authorization: !secret notify_api_key_header
      Content-Type: "application/json"
    payload: >
      {
        "message": "{{ message }}",
        "title": "{{ title | default('Home Assistant') }}",
        "target": "{{ target | default('general') }}",
        "data": { "priority": "{{ priority | default('normal') }}" }
      }
```

```yaml
action:
  - service: rest_command.home_notify_ha
    data:
      title: "Front door"
      message: "Motion detected at the front door"
      target: "security"
      priority: "high"
```

---

## Deduplication tip

If a noisy sensor may fire repeatedly, pass a stable `dedup_key`. Non-critical
duplicates within the cooldown window (default 5 minutes) are aggregated instead
of resent. Critical messages are never suppressed.

---

## Receiving action buttons (bidirectional)

When a user presses an action button, the service POSTs to that action's `url`.
The call is **signed**, because it can perform a real physical action — you
should verify it rather than acting on any request that reaches the endpoint.

Headers:

| Header | Meaning |
|---|---|
| `X-Notify-Signature` | `sha256=<hex>` — HMAC-SHA256 of `${timestamp}.${rawBody}` |
| `X-Notify-Timestamp` | Unix seconds, used to reject replays |

Body:

```json
{
  "message_id": "uuid",
  "action_id": "unlock",
  "user_id": "uuid",
  "user_name": "matti",
  "topic": "security",
  "priority": "high",
  "title": "Someone at the door",
  "triggered_at": "2026-07-12T09:41:00.000Z"
}
```

The signing key is `WEBHOOK_SIGNING_SECRET` from `.env` (falling back to
`SESSION_SECRET` if unset).

Verify it before acting. Reject anything older than a few minutes, and compare
the HMAC in constant time:

```python
import hashlib, hmac, time

def verify(raw_body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:      # replay window
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

Sending an action button:

```bash
curl -X POST https://notify.example.com/v1/notify \
  -H "Authorization: Bearer $NOTIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "security",
    "priority": "high",
    "title": "Someone at the door",
    "body": "Motion at the front door",
    "actions": [
      { "id": "unlock", "label": "Unlock", "url": "https://ha.example.com/api/webhook/notify-unlock" }
    ]
  }'
```

**iOS note:** Safari does not render notification action buttons. iPhone users
press the button in the app's Inbox instead, which is why the Inbox shows the
same actions. The result (including a failed webhook) is reported back to them —
a button that silently does nothing is worse than no button.

## Deduplication and aggregation

Pass a stable `dedup_key` for noisy sensors. Repeats within the cooldown window
are suppressed, **counted**, and then folded back into the original notification
when the window closes ("Repeated 6 times while muted."). The push reuses the
same `tag`, so it replaces the existing notification rather than stacking a
second one, and the Inbox keeps one entry.

Critical messages are never suppressed. The window defaults to
`DEDUP_COOLDOWN_SECONDS` and can be set per topic in Settings → Deduplication
cooldown.
