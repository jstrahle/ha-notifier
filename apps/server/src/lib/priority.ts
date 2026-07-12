/**
 * Notification priority levels, ordered from lowest to highest.
 * The router uses this ordering for min-priority filtering and to decide
 * when quiet hours and deduplication are bypassed.
 */
export const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export type Priority = (typeof PRIORITIES)[number];

const RANK: Record<Priority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

export function priorityRank(p: Priority): number {
  return RANK[p];
}

/** Returns true if `a` is at least as high as `b`. */
export function priorityAtLeast(a: Priority, b: Priority): boolean {
  return RANK[a] >= RANK[b];
}

/** Critical is the only level that bypasses quiet hours and dedup. */
export function isCritical(p: Priority): boolean {
  return p === 'critical';
}
