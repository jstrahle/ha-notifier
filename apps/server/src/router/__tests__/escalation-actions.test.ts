import { describe, it, expect, beforeEach } from 'vitest';
import { EscalationProcessor } from '../escalation.js';
import { Router, type RouterConfig } from '../router.js';
import {
  MemoryStore,
  MemoryDedupStore,
  MemoryQueue,
  MemoryActionInvoker,
  FixedClock,
} from '../memory.js';
import type { EscalationRule, MessageInput, Subscriber } from '../types.js';

/**
 * Escalation actions: the system closing the valve nobody came to close.
 *
 * This is the only place in the product where software takes a physical action
 * in the world, unattended. The tests below are therefore written around what
 * must never happen, not merely what should:
 *
 *   - it must not act if a human already dealt with the alert
 *   - it must not act twice because a queue job was retried
 *   - it must not act on an action the sender did not mark as safe to automate
 *   - it must not fail silently: people have to be told what it did, and told
 *     loudly if it could not
 *   - the notification it produces must not start another escalation
 */
const TENANT = 't1';
const TOPIC = 'topic-security';
const MSG = 'm1';

const config: RouterConfig = {
  dedupCooldownSeconds: 300,
  ackTokenTtlSeconds: 3600,
  smsEnabled: true,
};

const alice: Subscriber = {
  userId: 'alice',
  smsNumber: '+358401111111',
  minPriority: 'normal',
  quietStart: null,
  quietEnd: null,
  channelPref: 'auto',
};
const bob: Subscriber = { ...alice, userId: 'bob', smsNumber: '+358402222222' };

const CLOSE_VALVE = {
  id: 'shutoff',
  label: 'Close valve',
  url: 'https://ha.local/api/webhook/SECRET',
  escalate: true,
};
const CALL_PLUMBER = {
  id: 'plumber',
  label: 'Call the plumber',
  url: 'https://ha.local/api/webhook/OTHER',
  // no escalate flag — a human may press it; the system may not
};

const actionRule: EscalationRule = {
  id: 'r1',
  topicId: TOPIC,
  minPriority: 'critical',
  delaySeconds: 600,
  nextChannel: 'action',
  nextUserId: 'bob', // who gets told, by SMS, how it went
  stepOrder: 1,
};

describe('escalation actions', () => {
  let store: MemoryStore;
  let queue: MemoryQueue;
  let invoker: MemoryActionInvoker;
  let clock: FixedClock;
  let proc: EscalationProcessor;

  beforeEach(() => {
    clock = new FixedClock(new Date(2025, 0, 1, 3, 0)); // 3am, naturally
    store = new MemoryStore();
    queue = new MemoryQueue();
    invoker = new MemoryActionInvoker();
    proc = new EscalationProcessor(store, queue, config, invoker, clock);

    store.setSubscribers(TENANT, TOPIC, [alice, bob]);
    store.setEscalationRules([actionRule]);
    store.addMessage(MSG, null, 'Kitchen sensor triggered', Date.now(), {
      title: 'Water leak in kitchen',
      actions: [CLOSE_VALVE, CALL_PLUMBER],
    });
  });

  /* ------------------------------------------------------ the happy path --- */

  it('runs the escalatable action when nobody acknowledged', async () => {
    const res = await proc.run(TENANT, MSG, TOPIC, 1);

    expect(res.cancelledByAck).toBe(false);
    expect(invoker.invoked).toEqual([
      { actionId: 'shutoff', url: CLOSE_VALVE.url },
    ]);
    expect(res.actionsRun).toEqual([
      { actionId: 'shutoff', label: 'Close valve', ok: true, error: null, ran: true },
    ]);
  });

  it('runs every escalatable action, not just the first', async () => {
    store.addMessage('m2', null, 'x', Date.now(), {
      title: 'Leak',
      actions: [
        CLOSE_VALVE,
        { id: 'power', label: 'Cut power', url: 'https://ha.local/api/webhook/P', escalate: true },
        CALL_PLUMBER,
      ],
    });

    await proc.run(TENANT, 'm2', TOPIC, 1);

    expect(invoker.invoked.map((i) => i.actionId)).toEqual(['shutoff', 'power']);
  });

  /* ------------------------------------------------ what must never happen --- */

  it('does NOT act on an action the sender did not mark escalatable', async () => {
    // "Call the plumber" is a perfectly good button for a human. The system
    // must not press it.
    await proc.run(TENANT, MSG, TOPIC, 1);

    expect(invoker.invoked.map((i) => i.actionId)).not.toContain('plumber');
  });

  it('does NOT act if a human already acknowledged the alert', async () => {
    const d = await store.createDelivery({
      messageId: MSG,
      userId: 'alice',
      channel: 'webpush',
      ackToken: null,
      ackTokenExp: null,
    });
    store.acknowledge(d.id);

    const res = await proc.run(TENANT, MSG, TOPIC, 1);

    expect(res.cancelledByAck).toBe(true);
    expect(invoker.invoked).toHaveLength(0); // the valve stays open — alice has it
    expect(store.systemMessages).toHaveLength(0);
  });

  it('does NOT act twice when the queue job is retried', async () => {
    await proc.run(TENANT, MSG, TOPIC, 1);
    const second = await proc.run(TENANT, MSG, TOPIC, 1); // redelivery

    expect(invoker.invoked).toHaveLength(1); // the valve is closed once
    expect(second.actionsRun[0]).toMatchObject({ actionId: 'shutoff', ran: false });
  });

  it('does NOT act when the alert carries no escalatable action', async () => {
    store.addMessage('m3', null, 'x', Date.now(), {
      title: 'Door opened',
      actions: [CALL_PLUMBER],
    });

    const res = await proc.run(TENANT, 'm3', TOPIC, 1);

    expect(invoker.invoked).toHaveLength(0);
    expect(res.actionsRun).toHaveLength(0);
    // Nothing happened, so there is nothing to announce.
    expect(store.systemMessages).toHaveLength(0);
  });

  /* -------------------------------------------------------- telling people --- */

  it('tells everyone the system acted, and SMSes the person named on the step', async () => {
    const res = await proc.run(TENANT, MSG, TOPIC, 1);

    const report = store.systemMessages[0]!;
    expect(report.title).toBe('Automatic action triggered');
    expect(report.body).toContain('Close valve');
    expect(report.body).toContain('Water leak in kitchen');
    expect(report.priority).toBe('high');

    // The wording must not overclaim. All the server knows is that the webhook
    // returned 2xx — and Home Assistant answers a webhook on receipt, before the
    // automation behind it has done anything. Telling someone "the valve closed"
    // on that basis would make them stop worrying about something they should
    // still be worrying about.
    expect(report.body).not.toMatch(/\bran\b|\bclosed\b|\bdone\b/i);
    expect(report.body).toMatch(/not confirmed/i);

    // Push to every subscriber: the household must not find the water off with
    // no explanation.
    expect(res.escalatedTo).toContainEqual({ userId: 'alice', channel: 'webpush' });
    expect(res.escalatedTo).toContainEqual({ userId: 'bob', channel: 'webpush' });
    // SMS to the person the step names.
    expect(res.escalatedTo).toContainEqual({ userId: 'bob', channel: 'sms' });
  });

  it('raises a FAILED action as critical — a valve that did not close is worse', async () => {
    invoker.failWith = 'Receiver returned 500';

    const res = await proc.run(TENANT, MSG, TOPIC, 1);

    expect(res.actionsRun[0]).toMatchObject({ ok: false, ran: true });

    const report = store.systemMessages[0]!;
    expect(report.title).toBe('Automatic action FAILED');
    expect(report.priority).toBe('critical'); // louder than success, on purpose
    expect(report.body).toContain('500');
    expect(report.body).toMatch(/deal with it yourself/i);
    expect(res.escalatedTo).toContainEqual({ userId: 'bob', channel: 'sms' });
  });

  /* ------------------------------------------------------------ the loop --- */

  it("the report it produces can never start an escalation of its own", async () => {
    await proc.run(TENANT, MSG, TOPIC, 1);
    const report = store.systemMessages[0]!;

    // The guard as stored...
    expect(report.escalates).toBe(false);

    // ...and as the router enforces it. Without this, reporting "valve closed"
    // would arm a chain, close the valve again, report again, for ever.
    const router = new Router(
      store,
      new MemoryDedupStore(clock),
      queue,
      config,
      clock,
    );
    const asInput: MessageInput = {
      id: report.id,
      tenantId: TENANT,
      topicId: TOPIC,
      topicName: 'security',
      priority: 'critical',
      title: report.title,
      body: report.body,
      dedupKey: null,
      actions: null,
      dedupCooldownSeconds: null,
      escalates: false,
    };

    const routed = await router.route(asInput);
    expect(routed.escalationScheduled).toBe(false);
  });

  /* ------------------------------------------------------ chain continues --- */

  it('the chain carries on after the action step', async () => {
    store.setEscalationRules([
      actionRule,
      {
        id: 'r2',
        topicId: TOPIC,
        minPriority: 'critical',
        delaySeconds: 900,
        nextChannel: 'sms',
        nextUserId: 'alice',
        stepOrder: 2,
      },
    ]);

    const res = await proc.run(TENANT, MSG, TOPIC, 1);

    expect(res.nextStepScheduled).toBe(true);
    expect(queue.scheduledEscalations).toContainEqual({
      messageId: MSG,
      stepOrder: 2,
      delaySeconds: 900,
    });
  });
});
