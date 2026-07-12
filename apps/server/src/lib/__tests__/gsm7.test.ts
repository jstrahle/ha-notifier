import { describe, it, expect } from 'vitest';
import { toGsm7, toGsm7Sms, isGsm7Safe } from '../gsm7.js';

describe('GSM-7 sanitisation', () => {
  // The bug this exists to prevent: RouterOS silently drops non-GSM-7
  // characters, so "Hellö!" arrives as "Hell!" — letters vanish with no error.
  it('transliterates Finnish characters instead of losing them', () => {
    expect(toGsm7('Vesivuoto keittiössä')).toBe('Vesivuoto keittiossa');
    expect(toGsm7('Hälytys: ovi auki')).toBe('Halytys: ovi auki');
    expect(toGsm7('Ähtäri Åbo Örebro')).toBe('Ahtari Abo Orebro');
  });

  it('leaves plain ASCII untouched', () => {
    const s = 'Water leak in kitchen. Sensor 3 triggered at 14:32.';
    expect(toGsm7(s)).toBe(s);
    expect(isGsm7Safe(s)).toBe(true);
  });

  it('preserves the ack URL exactly', () => {
    const url = 'https://notify.example.com/a/Ab3-_xYz09';
    expect(toGsm7(url)).toBe(url);
  });

  it('replaces unrepresentable characters with ? rather than deleting them', () => {
    // Silently deleting would produce a subtly wrong sentence; a '?' at least
    // signals that something was lost.
    expect(toGsm7('fire 🔥 alarm')).toBe('fire ? alarm');
    expect(toGsm7('温度')).toBe('??');
  });

  it('normalises typographic punctuation people paste in without noticing', () => {
    expect(toGsm7('the sensor\u2019s reading \u2013 high')).toBe("the sensor's reading - high");
    expect(toGsm7('25\u00B0C')).toBe('25 degC');
    expect(toGsm7('5\u20AC')).toBe('5EUR');
  });

  it('reports unsafe input', () => {
    expect(isGsm7Safe('keittiössä')).toBe(false);
  });
});

describe('toGsm7Sms', () => {
  it('fits a single segment', () => {
    const long = 'a'.repeat(300);
    expect(toGsm7Sms(long)).toHaveLength(160);
    expect(toGsm7Sms(long).endsWith('...')).toBe(true);
  });

  it('does not truncate what already fits', () => {
    expect(toGsm7Sms('short message')).toBe('short message');
  });

  it('sanitises before measuring length', () => {
    // 'ß' becomes 'ss', so length is computed after transliteration.
    expect(toGsm7Sms('Straße')).toBe('Strasse');
  });

  it('honours a custom limit, leaving room for the ack link', () => {
    const out = toGsm7Sms('x'.repeat(100), 20);
    expect(out).toHaveLength(20);
  });
});
