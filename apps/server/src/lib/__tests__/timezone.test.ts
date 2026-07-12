import { describe, it, expect } from 'vitest';
import { validateTimezone } from '../../config.js';

describe('TZ validation', () => {
  it('accepts IANA tz database names', () => {
    expect(() => validateTimezone('Europe/Helsinki')).not.toThrow();
    expect(() => validateTimezone('America/New_York')).not.toThrow();
    expect(() => validateTimezone('UTC')).not.toThrow();
  });

  it('accepts an unset TZ (falls back to the system zone)', () => {
    expect(() => validateTimezone(undefined)).not.toThrow();
  });

  // Intl.DateTimeFormat happily accepts offset identifiers like "+02:00", so a
  // shape check is required on top of it. An offset cannot express DST, which
  // would drift quiet hours by an hour twice a year.
  it.each(['GMT+2', '+02:00', '-05:00', 'EET', 'Helsinki', 'Europe'])(
    'rejects %s',
    (bad) => {
      expect(() => validateTimezone(bad)).toThrow(/IANA/);
    },
  );

  it('accepts Etc/ zones, which are legitimate IANA names', () => {
    expect(() => validateTimezone('Etc/UTC')).not.toThrow();
  });

  it('rejects a typo instead of silently using UTC', () => {
    expect(() => validateTimezone('Europe/Helsingfors')).toThrow(/Invalid TZ/);
  });
});
