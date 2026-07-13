import { describe, it, expect } from 'vitest';
import { normaliseHaPayload } from '../homeassistant.js';

/**
 * Home Assistant sends the same information in two different shapes depending on
 * which integration route is used, and getting the precedence wrong would mean a
 * critical alert silently downgrading to 'normal'.
 *
 *   notify.rest   -> config-level `data:` is merged at the TOP level
 *   rest_command  -> extras are NESTED inside a `data` object
 */
describe('Home Assistant payload normalisation', () => {
  it('accepts the notify.rest shape (extras flattened to the top level)', () => {
    const m = normaliseHaPayload({
      message: 'Kitchen leak sensor triggered',
      title: 'Water leak',
      target: 'security',
      priority: 'critical',
    });

    expect(m).toMatchObject({
      topicName: 'security',
      priority: 'critical',
      title: 'Water leak',
      body: 'Kitchen leak sensor triggered',
    });
  });

  it('accepts the rest_command / native notify shape (extras nested in data)', () => {
    const m = normaliseHaPayload({
      message: 'Kitchen leak sensor triggered',
      title: 'Water leak',
      target: 'security',
      data: { priority: 'critical', dedup_key: 'leak-kitchen' },
    });

    expect(m).toMatchObject({
      topicName: 'security',
      priority: 'critical',
      dedupKey: 'leak-kitchen',
    });
  });

  // Nested is the per-call form; top level usually comes from static YAML. The
  // more specific one must win, or a per-automation override would be ignored.
  it('prefers the nested value when both are present', () => {
    const m = normaliseHaPayload({
      message: 'x',
      priority: 'normal',
      data: { priority: 'critical' },
    });
    expect(m.priority).toBe('critical');
  });

  it('defaults priority to normal when neither is given', () => {
    expect(normaliseHaPayload({ message: 'x' }).priority).toBe('normal');
  });

  it('defaults the topic to general when no target is given', () => {
    expect(normaliseHaPayload({ message: 'x' }).topicName).toBe('general');
    expect(normaliseHaPayload({ message: 'x', target: '' }).topicName).toBe('general');
  });

  // HA's notify service allows a list of targets.
  it('takes the first target when HA sends a list', () => {
    const m = normaliseHaPayload({ message: 'x', target: ['security', 'general'] });
    expect(m.topicName).toBe('security');
  });

  it('defaults the title, since HA notify makes it optional', () => {
    expect(normaliseHaPayload({ message: 'x' }).title).toBe('Home Assistant');
  });

  it('carries action buttons through in either shape', () => {
    const action = { id: 'unlock', label: 'Unlock', url: 'https://ha.local/api/webhook/x' };

    expect(normaliseHaPayload({ message: 'x', actions: [action] }).actions).toEqual([action]);
    expect(
      normaliseHaPayload({ message: 'x', data: { actions: [action] } }).actions,
    ).toEqual([action]);
  });

  it('leaves optional fields null rather than undefined', () => {
    const m = normaliseHaPayload({ message: 'x' });
    expect(m.dedupKey).toBeNull();
    expect(m.actions).toBeNull();
    expect(m.mediaUrl).toBeNull();
  });
});
