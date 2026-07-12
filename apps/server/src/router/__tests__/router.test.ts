import { describe, it, expect, beforeEach } from 'vitest';
import { Router, type RouterConfig } from '../router.js';
import { EscalationProcessor } from '../escalation.js';
import {
  MemoryStore,
  MemoryDedupStore,
  MemoryQueue,
  FixedClock,
} from '../memory.js';
import type { MessageInput, Subscriber, EscalationRule } from '../types.js';

const TENANT = 't1';
const TOPIC = 'topic-security';

const config: RouterConfig = {
  dedupCooldownSeconds: 300,
  ackTokenTtlSeconds: 3600,
  smsEnabled: true,
};

/** A deployment with no SMS provider configured — the default install. */
const configNoSms: RouterConfig = { ...config, smsEnabled: false };

function makeMessage(over: Partial<MessageInput> = {}): MessageInput {
  return {
    id: over.id ?? 'm1',
    tenantId: TENANT,
    topicId: TOPIC,
    topicName: 'security',
    priority: 'normal',
    title: 'Test',
    body: 'Body',
    dedupKey: null,
    actions: null,
    dedupCooldownSeconds: null,
    ...over,
  };
}

const alice: Subscriber = {
  userId: 'alice',
  smsNumber: '+358401111111',
  minPriority: 'normal',
  quietStart: null,
  quietEnd: null,
  channelPref: 'auto',
};

const bob: Subscriber = {
  userId: 'bob',
  smsNumber: '+358402222222',
  minPriority: 'normal',
  quietStart: '22:00',
  quietEnd: '07:00',
  channelPref: 'auto',
};

describe('Router (in-memory end-to-end)', () => {
  let store: MemoryStore;
  let dedup: MemoryDedupStore;
  let queue: MemoryQueue;
  let clock: FixedClock;
  let router: Router;

  beforeEach(() => {
    clock = new FixedClock(new Date(2025, 0, 1, 12, 0)); // noon, not quiet
    store = new MemoryStore();
    dedup = new MemoryDedupStore(clock);
    queue = new MemoryQueue();
    router = new Router(store, dedup, queue, config, clock);
  });

  it('delivers a normal message via webpush to all eligible subscribers', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice, bob]);
    const res = await router.route(makeMessage());
    expect(res.suppressedAsDuplicate).toBe(false);
    expect(res.plannedDeliveries).toEqual([
      { userId: 'alice', channel: 'webpush' },
      { userId: 'bob', channel: 'webpush' },
    ]);
    expect(queue.enqueuedDeliveries).toHaveLength(2);
  });

  it('filters out subscribers whose min_priority is above the message', async () => {
    const picky: Subscriber = { ...bob, userId: 'picky', minPriority: 'high' };
    store.setSubscribers(TENANT, TOPIC, [alice, picky]);
    const res = await router.route(makeMessage({ priority: 'normal' }));
    expect(res.plannedDeliveries.map((d) => d.userId)).toEqual(['alice']);
  });

  it('sends critical to both webpush and sms', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    const res = await router.route(makeMessage({ priority: 'critical' }));
    expect(res.plannedDeliveries).toEqual([
      { userId: 'alice', channel: 'webpush' },
      { userId: 'alice', channel: 'sms' },
    ]);
  });

  it('suppresses non-critical duplicates within cooldown', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    store.addMessage('m1', 'leak-kitchen');
    const first = await router.route(
      makeMessage({ id: 'm1', dedupKey: 'leak-kitchen' }),
    );
    expect(first.suppressedAsDuplicate).toBe(false);

    const second = await router.route(
      makeMessage({ id: 'm2', dedupKey: 'leak-kitchen' }),
    );
    expect(second.suppressedAsDuplicate).toBe(true);
    expect(second.plannedDeliveries).toHaveLength(0);
    expect(store.duplicateCounts.get(`${TENANT}::leak-kitchen`)).toBe(1);
  });

  it('arms an aggregation flush on the first message with a dedup key', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    store.addMessage('m1', 'leak-kitchen');
    const res = await router.route(makeMessage({ id: 'm1', dedupKey: 'leak-kitchen' }));

    expect(res.aggregationScheduled).toBe(true);
    expect(queue.scheduledAggregations).toEqual([
      { tenantId: TENANT, dedupKey: 'leak-kitchen', delaySeconds: 300 },
    ]);
  });

  it('honours a per-topic cooldown override', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    store.addMessage('m1', 'door');
    await router.route(
      makeMessage({ id: 'm1', dedupKey: 'door', dedupCooldownSeconds: 30 }),
    );
    expect(queue.scheduledAggregations[0]?.delaySeconds).toBe(30);
  });

  it('does not arm aggregation for a message with no dedup key', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    const res = await router.route(makeMessage());
    expect(res.aggregationScheduled).toBe(false);
    expect(queue.scheduledAggregations).toHaveLength(0);
  });

  it('never suppresses critical messages even with a dedup key', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    await router.route(
      makeMessage({ id: 'm1', dedupKey: 'fire', priority: 'critical' }),
    );
    const second = await router.route(
      makeMessage({ id: 'm2', dedupKey: 'fire', priority: 'critical' }),
    );
    expect(second.suppressedAsDuplicate).toBe(false);
    expect(second.plannedDeliveries.length).toBeGreaterThan(0);
  });

  it('suppresses non-critical during quiet hours but lets critical through', async () => {
    clock.set(new Date(2025, 0, 1, 3, 0)); // 03:00, inside bob's quiet window
    store.setSubscribers(TENANT, TOPIC, [bob]);

    const normal = await router.route(makeMessage({ priority: 'normal' }));
    expect(normal.plannedDeliveries).toHaveLength(0);

    const critical = await router.route(
      makeMessage({ id: 'm2', priority: 'critical' }),
    );
    expect(critical.plannedDeliveries.length).toBeGreaterThan(0);
  });

  it('arms an escalation timer for critical messages when a rule exists', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    const rule: EscalationRule = {
      id: 'r1',
      topicId: TOPIC,
      minPriority: 'critical',
      delaySeconds: 180,
      nextChannel: 'sms',
      nextUserId: 'bob',
      stepOrder: 1,
    };
    store.setEscalationRules([rule]);

    const res = await router.route(makeMessage({ priority: 'critical' }));
    expect(res.escalationScheduled).toBe(true);
    expect(queue.scheduledEscalations).toEqual([
      { messageId: 'm1', stepOrder: 1, delaySeconds: 180 },
    ]);
  });

  // Regression: with SMS_PROVIDER=none, the default 'auto' preference must
  // still deliver over web push. Previously a critical message to a user with a
  // phone number queued an SMS delivery that could never be sent.
  it('auto still delivers over web push when SMS is not configured', async () => {
    const routerNoSms = new Router(store, dedup, queue, configNoSms, clock);
    store.setSubscribers(TENANT, TOPIC, [alice]); // alice has an sms number

    const res = await routerNoSms.route(makeMessage({ priority: 'critical' }));
    expect(res.plannedDeliveries).toEqual([
      { userId: 'alice', channel: 'webpush' },
    ]);
    expect(queue.enqueuedDeliveries).toHaveLength(1);
  });

  // Regression: every delivery, not just SMS, needs an ack token so the service
  // worker can acknowledge from a notification button without a live session.
  it('issues an ack token for web push deliveries too', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    await router.route(makeMessage());

    const webpushDelivery = store.deliveries.find((d) => d.channel === 'webpush');
    expect(webpushDelivery?.ackToken).toBeTruthy();
  });

  it('does not arm escalation for a normal message', async () => {
    store.setSubscribers(TENANT, TOPIC, [alice]);
    store.setEscalationRules([
      {
        id: 'r1',
        topicId: TOPIC,
        minPriority: 'critical',
        delaySeconds: 180,
        nextChannel: 'sms',
        nextUserId: null,
        stepOrder: 1,
      },
    ]);
    const res = await router.route(makeMessage({ priority: 'normal' }));
    expect(res.escalationScheduled).toBe(false);
  });
});

describe('EscalationProcessor', () => {
  let store: MemoryStore;
  let queue: MemoryQueue;
  let clock: FixedClock;
  let proc: EscalationProcessor;

  const twoStepRules: EscalationRule[] = [
    {
      id: 'r1',
      topicId: TOPIC,
      minPriority: 'critical',
      delaySeconds: 180,
      nextChannel: 'sms',
      nextUserId: 'bob',
      stepOrder: 1,
    },
    {
      id: 'r2',
      topicId: TOPIC,
      minPriority: 'critical',
      delaySeconds: 300,
      nextChannel: 'sms',
      nextUserId: 'carol',
      stepOrder: 2,
    },
  ];

  const carol: Subscriber = { ...bob, userId: 'carol', smsNumber: '+358403333333' };

  beforeEach(() => {
    clock = new FixedClock(new Date(2025, 0, 1, 12, 0));
    store = new MemoryStore();
    queue = new MemoryQueue();
    proc = new EscalationProcessor(store, queue, config, clock);
    store.setSubscribers(TENANT, TOPIC, [alice, bob, carol]);
    store.setEscalationRules(twoStepRules);
    store.setEscalationRules(twoStepRules);
  });

  it('escalates to the next user and schedules the following step', async () => {
    const res = await proc.run(TENANT, 'm1', TOPIC, 1);
    expect(res.cancelledByAck).toBe(false);
    expect(res.escalatedTo).toEqual([{ userId: 'bob', channel: 'sms' }]);
    expect(res.nextStepScheduled).toBe(true);
    expect(queue.scheduledEscalations).toEqual([
      { messageId: 'm1', stepOrder: 2, delaySeconds: 300 },
    ]);
  });

  it('cancels the entire chain if any delivery was acknowledged', async () => {
    const d = await store.createDelivery({
      messageId: 'm1',
      userId: 'alice',
      channel: 'webpush',
      ackToken: null,
      ackTokenExp: null,
    });
    store.acknowledge(d.id);

    const res = await proc.run(TENANT, 'm1', TOPIC, 1);
    expect(res.cancelledByAck).toBe(true);
    expect(res.escalatedTo).toHaveLength(0);
    expect(res.nextStepScheduled).toBe(false);
    expect(queue.scheduledEscalations).toHaveLength(0);
  });

  it('runs the last step without scheduling a further one', async () => {
    const res = await proc.run(TENANT, 'm1', TOPIC, 2);
    expect(res.escalatedTo).toEqual([{ userId: 'carol', channel: 'sms' }]);
    expect(res.nextStepScheduled).toBe(false);
  });
});
