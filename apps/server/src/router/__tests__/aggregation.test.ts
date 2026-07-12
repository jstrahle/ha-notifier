import { describe, it, expect, beforeEach } from 'vitest';
import { AggregationProcessor, summarize } from '../aggregation.js';
import { MemoryStore, MemoryQueue } from '../memory.js';

const TENANT = 't1';
const KEY = 'leak-kitchen';

describe('summarize', () => {
  it('appends a readable repeat count', () => {
    expect(summarize('Leak detected', 6)).toContain('6 times');
    expect(summarize('Leak detected', 1)).toContain('once');
  });

  it('handles an empty body', () => {
    expect(summarize('', 3)).toBe('Repeated 3 times while muted.');
  });
});

describe('AggregationProcessor', () => {
  let store: MemoryStore;
  let queue: MemoryQueue;
  let proc: AggregationProcessor;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new MemoryQueue();
    proc = new AggregationProcessor(store, queue);
  });

  it('stays quiet when nothing was suppressed', async () => {
    store.addMessage('m1', KEY, 'Leak detected');
    const res = await proc.run(TENANT, KEY);

    expect(res.flushed).toBe(false);
    expect(queue.enqueuedDeliveries).toHaveLength(0);
    // The body must not be touched when there is nothing to report.
    expect(store.getMessage('m1')?.body).toBe('Leak detected');
  });

  it('folds suppressed duplicates into the original message and re-sends it', async () => {
    store.addMessage('m1', KEY, 'Leak detected');
    await store.createDelivery({
      messageId: 'm1',
      userId: 'alice',
      channel: 'webpush',
      ackToken: 'tok',
      ackTokenExp: null,
    });

    // Three duplicates arrive during the cooldown window.
    await store.recordDuplicate(TENANT, KEY);
    await store.recordDuplicate(TENANT, KEY);
    await store.recordDuplicate(TENANT, KEY);

    const res = await proc.run(TENANT, KEY);

    expect(res.flushed).toBe(true);
    expect(res.duplicateCount).toBe(3);
    expect(res.resentDeliveries).toBe(1);
    expect(store.getMessage('m1')?.body).toContain('3 times');
    // Re-sending the SAME delivery means the push replaces the existing
    // notification (same tag) and the Inbox keeps one row, not two.
    expect(queue.enqueuedDeliveries).toEqual(['d1']);
  });

  it('resets the counter so the next window starts clean', async () => {
    store.addMessage('m1', KEY, 'Leak detected');
    await store.recordDuplicate(TENANT, KEY);
    await proc.run(TENANT, KEY);

    expect(store.getMessage('m1')?.duplicateCount).toBe(0);

    // A second flush with no new duplicates must not re-announce.
    const second = await proc.run(TENANT, KEY);
    expect(second.flushed).toBe(false);
  });

  it('does not re-send SMS deliveries (they cost money and would spam)', async () => {
    store.addMessage('m1', KEY, 'Leak detected');
    await store.createDelivery({
      messageId: 'm1',
      userId: 'alice',
      channel: 'sms',
      ackToken: 'tok',
      ackTokenExp: null,
    });
    await store.recordDuplicate(TENANT, KEY);

    const res = await proc.run(TENANT, KEY);
    expect(res.resentDeliveries).toBe(0);
    expect(queue.enqueuedDeliveries).toHaveLength(0);
  });

  it('does not re-send an already acknowledged delivery', async () => {
    store.addMessage('m1', KEY, 'Leak detected');
    const d = await store.createDelivery({
      messageId: 'm1',
      userId: 'alice',
      channel: 'webpush',
      ackToken: 'tok',
      ackTokenExp: null,
    });
    store.acknowledge(d.id);
    await store.recordDuplicate(TENANT, KEY);

    const res = await proc.run(TENANT, KEY);
    expect(res.resentDeliveries).toBe(0);
  });
});
