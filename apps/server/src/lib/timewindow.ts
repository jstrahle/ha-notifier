/**
 * Quiet-hours evaluation.
 *
 * A quiet window is defined by two "HH:MM" local times. It may wrap past
 * midnight (e.g. 22:00 -> 07:00). Non-critical messages are suppressed for a
 * user while the current local time falls inside their quiet window; critical
 * messages always bypass this check (handled by the caller).
 */

export interface QuietWindow {
  start: string | null; // "HH:MM" or null (no window)
  end: string | null; // "HH:MM" or null
}

function toMinutes(hhmm: string): number {
  const parts = hhmm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (
    parts.length !== 2 ||
    Number.isNaN(h) ||
    Number.isNaN(m) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59
  ) {
    throw new Error(`Invalid time string: ${hhmm}`);
  }
  return h * 60 + m;
}

/**
 * Returns true if `now` (a Date, evaluated in the host's local time) falls
 * inside the quiet window. A window with a null bound is treated as "no
 * quiet hours" and always returns false.
 */
export function isInQuietHours(window: QuietWindow, now: Date): boolean {
  if (!window.start || !window.end) return false;

  const startMin = toMinutes(window.start);
  const endMin = toMinutes(window.end);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) {
    // Zero-length window: treat as no quiet hours.
    return false;
  }

  if (startMin < endMin) {
    // Same-day window, e.g. 09:00 -> 17:00.
    return nowMin >= startMin && nowMin < endMin;
  }

  // Overnight window, e.g. 22:00 -> 07:00.
  return nowMin >= startMin || nowMin < endMin;
}
