import { describe, it, expect } from 'vitest';
import {
  priorityAtLeast,
  isCritical,
  priorityRank,
  isPriority,
} from '../../lib/priority.js';
import { isInQuietHours } from '../../lib/timewindow.js';
import { selectChannels } from '../channels.js';

describe('priority', () => {
  it('orders low < normal < high < critical', () => {
    expect(priorityRank('low')).toBeLessThan(priorityRank('normal'));
    expect(priorityRank('normal')).toBeLessThan(priorityRank('high'));
    expect(priorityRank('high')).toBeLessThan(priorityRank('critical'));
  });

  it('priorityAtLeast compares correctly', () => {
    expect(priorityAtLeast('high', 'normal')).toBe(true);
    expect(priorityAtLeast('normal', 'normal')).toBe(true);
    expect(priorityAtLeast('low', 'normal')).toBe(false);
  });

  it('only critical is critical', () => {
    expect(isCritical('critical')).toBe(true);
    expect(isCritical('high')).toBe(false);
  });

  it('validates priority strings', () => {
    expect(isPriority('critical')).toBe(true);
    expect(isPriority('urgent')).toBe(false);
  });
});

describe('quiet hours', () => {
  const at = (h: number, m = 0) => new Date(2025, 0, 1, h, m);

  it('returns false when window is unset', () => {
    expect(isInQuietHours({ start: null, end: null }, at(3))).toBe(false);
    expect(isInQuietHours({ start: '22:00', end: null }, at(3))).toBe(false);
  });

  it('handles same-day window 09:00-17:00', () => {
    const w = { start: '09:00', end: '17:00' };
    expect(isInQuietHours(w, at(8, 59))).toBe(false);
    expect(isInQuietHours(w, at(9, 0))).toBe(true);
    expect(isInQuietHours(w, at(12))).toBe(true);
    expect(isInQuietHours(w, at(17, 0))).toBe(false); // end is exclusive
  });

  it('handles overnight window 22:00-07:00', () => {
    const w = { start: '22:00', end: '07:00' };
    expect(isInQuietHours(w, at(21, 59))).toBe(false);
    expect(isInQuietHours(w, at(22, 0))).toBe(true);
    expect(isInQuietHours(w, at(2))).toBe(true);
    expect(isInQuietHours(w, at(6, 59))).toBe(true);
    expect(isInQuietHours(w, at(7, 0))).toBe(false);
    expect(isInQuietHours(w, at(12))).toBe(false);
  });
});

describe('channel selection', () => {
  const withSms = { smsNumber: '+358401234567' };
  const noSms = { smsNumber: null };
  const SMS_ON = true;
  const SMS_OFF = false;

  it('push_only never returns sms', () => {
    expect(selectChannels('push_only', 'critical', withSms, SMS_ON)).toEqual([
      'webpush',
    ]);
  });

  it('sms_only uses sms when available', () => {
    expect(selectChannels('sms_only', 'normal', withSms, SMS_ON)).toEqual(['sms']);
  });

  it('sms_only falls back to push rather than dropping the message', () => {
    expect(selectChannels('sms_only', 'normal', noSms, SMS_ON)).toEqual(['webpush']);
    expect(selectChannels('sms_only', 'normal', withSms, SMS_OFF)).toEqual(['webpush']);
  });

  it('auto sends critical to both webpush and sms when sms is configured', () => {
    expect(selectChannels('auto', 'critical', withSms, SMS_ON)).toEqual([
      'webpush',
      'sms',
    ]);
  });

  it('auto sends critical to webpush only when no sms number', () => {
    expect(selectChannels('auto', 'critical', noSms, SMS_ON)).toEqual(['webpush']);
  });

  // Regression: with no SMS provider configured, "auto" must still deliver over
  // web push instead of queueing an SMS that can never be sent.
  it('auto works with no SMS provider configured', () => {
    expect(selectChannels('auto', 'critical', withSms, SMS_OFF)).toEqual(['webpush']);
    expect(selectChannels('auto', 'normal', withSms, SMS_OFF)).toEqual(['webpush']);
    expect(selectChannels('auto', 'normal', noSms, SMS_OFF)).toEqual(['webpush']);
  });

  it('auto sends non-critical to webpush only', () => {
    expect(selectChannels('auto', 'high', withSms, SMS_ON)).toEqual(['webpush']);
    expect(selectChannels('auto', 'normal', withSms, SMS_ON)).toEqual(['webpush']);
  });
});
