import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Generates a ready-to-paste Home Assistant configuration.
 *
 * The friction this removes is real: the token has to be written into
 * secrets.yaml *with the word "Bearer " as part of the value* — a classic
 * footgun that produces a 401 with no obvious cause — and the API key is only
 * ever shown once, at creation. So rather than asking the user to paste a key
 * they no longer have into YAML they have to hand-write, we mint a fresh key and
 * render the complete configuration around it.
 */
export function HomeAssistantSetup() {
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const key = await api.createApiKey(`home-assistant-${stamp}`);
      setYaml(buildYaml(location.origin, key.key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!yaml) return;
    await navigator.clipboard?.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-400">
        Home Assistant
      </h2>
      <p className="mb-2 text-xs text-neutral-500">
        Generates a new API key and the complete configuration to paste into Home
        Assistant. You get a real <code>notify.home_alert</code> action, just like{' '}
        <code>notify.pushover</code> — no custom component needed.
      </p>

      {error && (
        <p className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {!yaml ? (
        <button
          onClick={generate}
          disabled={busy}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate configuration'}
        </button>
      ) : (
        <div className="space-y-2">
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            This contains a <strong>new API key, shown only once</strong>. Copy it
            now — it cannot be recovered later. You can revoke it any time under
            API keys.
          </p>
          <pre className="max-h-80 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-xs leading-relaxed">
            {yaml}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={copy}
              className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white"
            >
              {copied ? '✓ Copied' : 'Copy YAML'}
            </button>
            <button
              onClick={() => setYaml(null)}
              className="px-3 py-1 text-sm text-neutral-500"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function buildYaml(origin: string, apiKey: string): string {
  return `# ---------------------------------------------------------------------------
# Home Alerts — Home Assistant configuration
#
# 1. Add the two lines below to secrets.yaml
# 2. Add the notify: block to configuration.yaml
# 3. Restart Home Assistant
#
# You then have notify.home_alert and notify.home_alert_critical, usable from
# the automation UI like any other notifier.
# ---------------------------------------------------------------------------

# ---- secrets.yaml ----
# NOTE: the word "Bearer " is part of the value. Without it you get a 401.
home_alert_token: "Bearer ${apiKey}"


# ---- configuration.yaml ----
#
# The three *_param_name lines are NOT optional. With method: POST_JSON, Home
# Assistant does not send the title or the target unless you name them here --
# so without these, every alert arrives titled "Home Assistant" and lands in the
# "general" topic, no matter what the automation says.
notify:
  # Everyday alerts: web push only.
  - name: home_alert
    platform: rest
    resource: ${origin}/v1/homeassistant/notify
    method: POST_JSON
    headers:
      Authorization: !secret home_alert_token
    message_param_name: message
    title_param_name: title
    target_param_name: target
    data:
      priority: normal
    data_template:
      # Lets any automation attach action buttons via its own data: field.
      # to_json is required: notify.rest renders templates to strings.
      actions: "{{ (data | default({})).get('actions', []) | to_json }}"

  # Critical alerts: web push AND SMS in parallel, bypassing quiet hours.
  # Use this one only for things that justify waking someone up.
  - name: home_alert_critical
    platform: rest
    resource: ${origin}/v1/homeassistant/notify
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


# ---- example automation ----
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
          target: "security"      # the topic; created automatically if new

          # Optional: action buttons, supplied per alert.
          # "escalate: true" lets the escalation run it if nobody responds —
          # only ever on actions that reach a SAFE state (close a valve, cut
          # power). Never one that unlocks a door.
          data:
            actions:
              - id: shutoff
                label: "Close valve"
                url: "http://192.168.1.50:8123/api/webhook/YOUR-SECRET-ID"
                escalate: true
`;
}
