import { Queue as BullQueue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Queue } from './types.js';

export const QUEUE_NAMES = {
  notify: 'notify',
  delivery: 'delivery',
  escalation: 'escalation',
  aggregation: 'aggregation',
} as const;

/**
 * BullMQ implementation of the router's Queue port. Delayed jobs give us
 * reliable escalation timers for free.
 */
export class BullMqQueue implements Queue {
  private deliveryQueue: BullQueue;
  private escalationQueue: BullQueue;
  private aggregationQueue: BullQueue;

  constructor(connection: Redis) {
    this.deliveryQueue = new BullQueue(QUEUE_NAMES.delivery, { connection });
    this.escalationQueue = new BullQueue(QUEUE_NAMES.escalation, { connection });
    this.aggregationQueue = new BullQueue(QUEUE_NAMES.aggregation, { connection });
  }

  async enqueueDelivery(deliveryId: string): Promise<void> {
    await this.deliveryQueue.add(
      'deliver',
      { deliveryId },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000 },
    );
  }

  async scheduleEscalation(
    payload: { messageId: string; stepOrder: number },
    delaySeconds: number,
  ): Promise<void> {
    await this.escalationQueue.add('escalate', payload, {
      delay: delaySeconds * 1000,
      removeOnComplete: 1000,
    });
  }

  async scheduleAggregation(
    payload: { tenantId: string; dedupKey: string },
    delaySeconds: number,
  ): Promise<void> {
    await this.aggregationQueue.add('flush', payload, {
      delay: delaySeconds * 1000,
      // One flush per key per window: a duplicate arriving mid-window must not
      // queue a second flush.
      jobId: `flush:${payload.tenantId}:${payload.dedupKey}`,
      removeOnComplete: 1000,
    });
  }

  async close(): Promise<void> {
    await this.deliveryQueue.close();
    await this.escalationQueue.close();
    await this.aggregationQueue.close();
  }
}
