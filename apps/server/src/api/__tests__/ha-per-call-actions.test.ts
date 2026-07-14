import { describe, it, expect } from 'vitest';
import { parseHaPayload } from '../homeassistant.js';

/**
 * Per-call action buttons through `notify.rest`.
 *
 * The goal is one notifier per priority — `notify.home_alert`,
 * `notify.home_alert_critical` — with the buttons supplied by whichever
 * automation raises the alert, in its `data:` field. Not a notifier per alert
 * type.
 *
 * Home Assistant makes that possible but awkward. `notify.rest` renders its
 * `data_template:` against the service call's arguments, so an automation *can*
 * pass buttons:
 *
 *     data_template:
 *       actions: "{{ data.actions | to_json }}"
 *
 * — but it renders with `parse_result=False`, so what reaches the wire is a
 * JSON *string*, not an array. These tests use exactly that: the literal output
 * of `to_json`, escaping and all. A prettier fixture would prove nothing.
 *
 * If this broke, the failure would be silent: the alert still arrives, still
 * says "water leak", and simply has no buttons — so the escalation has nothing
 * to run and the valve never closes.
 */

/** What `{{ data.actions | to_json }}` actually renders to. */
function toJson(value: unknown): string {
  return JSON.stringify(value);
}

const ACTIONS = [
  {
    id: 'shutoff',
    label: 'Sulje venttiili',
    url: 'http://192.168.88.50:8123/api/webhook/SECRET',
    escalate: true,
  },
  {
    id: 'plumber',
    label: 'Soita putkimiehelle',
    url: 'http://192.168.88.50:8123/api/webhook/OTHER',
  },
];

function parse(body: unknown) {
  const r = parseHaPayload(body);
  if (!r.ok) throw new Error(r.error);
  return r.message;
}

describe('per-call actions from notify.rest', () => {
  it('accepts the payload notify.rest actually sends', () => {
    // Exactly the shape produced by:
    //   notify.home_alert_critical, data_template: { actions: "{{ data.actions | to_json }}" }
    const m = parse({
      message: 'Keittiön vuotoanturi laukesi',
      title: 'Vesivuoto keittiössä',
      target: 'security',
      priority: 'critical',
      actions: toJson(ACTIONS),
    });

    expect(m.title).toBe('Vesivuoto keittiössä');
    expect(m.topicName).toBe('security');
    expect(m.priority).toBe('critical');
    expect(m.actions).toEqual(ACTIONS);
  });

  it('preserves escalate through the string round-trip — the safety model', () => {
    const m = parse({ message: 'x', actions: toJson(ACTIONS) });

    const escalatable = m.actions!.filter((a) => a.escalate === true);
    // The valve may be closed unattended. The plumber may not be called.
    expect(escalatable.map((a) => a.id)).toEqual(['shutoff']);
  });

  it('survives non-ASCII labels, which JSON escapes', () => {
    const m = parse({
      message: 'x',
      actions: toJson([{ id: 'a', label: 'Sulje venttiili — heti', url: 'https://ha/x' }]),
    });
    expect(m.actions?.[0]?.label).toBe('Sulje venttiili — heti');
  });

  it('treats an empty render as no actions, not as an error', () => {
    // `{{ data.actions | default([]) | to_json }}` on a call with no data at all.
    expect(parse({ message: 'x', actions: '[]' }).actions).toEqual([]);
    expect(parse({ message: 'x', actions: '' }).actions).toBeNull();
  });

  it('treats an empty dedup_key render as none, not as a key of ""', () => {
    // `{{ data.dedup_key | default('') }}` when the automation passed none.
    // A literal '' would otherwise become a dedup key that every alert shares.
    expect(parse({ message: 'x', dedup_key: '' }).dedupKey).toBeNull();
    expect(parse({ message: 'x', dedup_key: 'leak-kitchen' }).dedupKey).toBe('leak-kitchen');
  });

  it('still accepts a real array, for senders that can send one', () => {
    expect(parse({ message: 'x', actions: ACTIONS }).actions).toEqual(ACTIONS);
  });

  it('rejects malformed JSON with a message that names the field', () => {
    const r = parseHaPayload({ message: 'x', actions: '[{"id": broken' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/actions/i);
  });
});
