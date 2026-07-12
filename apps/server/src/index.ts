import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Redis } from 'ioredis';
import './lib/fastify-augment.js';
import { loadConfig } from './config.js';
import { decodeSession, encodeSession, shouldRenew } from './lib/session.js';
import { sessionCookieOptions } from './lib/auth.js';
import { createContext } from './context.js';
import { registerNotifyRoutes } from './api/notify.js';
import { registerAckRoutes } from './api/ack.js';
import { registerAuthAndPushRoutes } from './api/auth.js';
import { registerManagementRoutes } from './api/management.js';
import { registerHomeAssistantRoutes } from './api/homeassistant.js';
import { startDeliveryWorker } from './workers/delivery.worker.js';
import {
  startNotifyWorker,
  startEscalationWorker,
  startAggregationWorker,
} from './workers/index.js';
import { startMqttBridge } from './integrations/mqtt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);

  const app = Fastify({ logger: true, trustProxy: true });
  app.decorate('db', ctx.db);
  app.decorate('ctx', ctx);

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { global: false });

  // Populate req.session from the signed cookie, and slide its expiry.
  const SESSION_MAX_AGE_SECONDS = config.SESSION_MAX_AGE_DAYS * 24 * 60 * 60;
  const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // re-issue at most once a day

  app.addHook('preHandler', async (req, reply) => {
    const raw = req.cookies?.sid;
    if (!raw) return;

    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;

    const token = decodeSession(unsigned.value);
    if (!token) return;

    req.session = token;

    // Sliding expiry: while the app is in use, push the deadline out. Without
    // this an active user is logged out on a fixed schedule — and would discover
    // it at the worst possible moment, when an alert arrives.
    if (shouldRenew(token, Date.now(), RENEW_AFTER_MS)) {
      reply.setCookie(
        'sid',
        encodeSession(token.userId, token.version),
        sessionCookieOptions(config, SESSION_MAX_AGE_SECONDS),
      );
    }
  });

  // Rate limits on the sensitive endpoints.
  app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.headers.authorization ?? req.ip,
    });
    await registerNotifyRoutes(scoped);
    await registerHomeAssistantRoutes(scoped);
  });

  app.register(async (scoped) => {
    await scoped.register(rateLimit, { max: 30, timeWindow: '1 minute' });
    await registerAckRoutes(scoped);
  });

  await registerAuthAndPushRoutes(app);
  await registerManagementRoutes(app);

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Serve the built PWA (dist copied next to the server in the image).
  const pwaDir = join(__dirname, '..', 'public');
  await app.register(fastifyStatic, { root: pwaDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/v1') || req.raw.url?.startsWith('/a/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
    }
    return reply.sendFile('index.html'); // SPA fallback
  });

  // Background workers (same image/process for the MVP).
  const workerConn = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const workers = [
    startNotifyWorker(ctx, workerConn),
    startDeliveryWorker(ctx, workerConn),
    startEscalationWorker(ctx, workerConn),
    startAggregationWorker(ctx, workerConn),
  ];
  const mqttClient = await startMqttBridge(ctx);

  const shutdown = async () => {
    app.log.info('Shutting down...');
    await Promise.allSettled(workers.map((w) => w.close()));
    mqttClient?.end();
    workerConn.disconnect();
    await app.close();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info(`Notification service listening on ${config.APP_URL}`);

  // Make the alerting configuration visible without guessing. A silently
  // disabled SMS channel means critical alerts cannot break through a muted
  // phone, which is the whole point of the product.
  if (ctx.sms.enabled) {
    const target =
      config.SMS_PROVIDER === 'mikrotik'
        ? `${config.MIKROTIK_URL} (port ${config.MIKROTIK_SMS_PORT})`
        : 'Twilio';
    app.log.info(`SMS channel ENABLED via ${config.SMS_PROVIDER} -> ${target}`);
  } else {
    app.log.warn(
      'SMS channel DISABLED (SMS_PROVIDER=none). Critical alerts will go out over web push only, ' +
        'which cannot break through a silenced iPhone.',
    );
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
