import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Static file serving and the SPA fallback.
 *
 * This layer had no tests at all, which is how a major version bump of
 * @fastify/static could go green in CI while silently breaking the thing every
 * user touches first: loading the app. The unit tests never construct a Fastify
 * instance, so `wildcard: false`, `reply.sendFile` and the not-found handler
 * were all taken on trust.
 *
 * It reproduces exactly what src/index.ts does, and uses `inject()`, so it needs
 * no port, no network and no build output.
 */
describe('serving the PWA', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    // Stand in for the built PWA: an index.html and a fingerprinted bundle.
    dir = await mkdtemp(join(tmpdir(), 'pwa-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(join(dir, 'manifest.webmanifest'), '{"name":"Home"}');

    app = Fastify();

    // Identical to src/index.ts.
    await app.register(fastifyStatic, { root: dir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/v1') || req.raw.url?.startsWith('/a/')) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
      }
      return reply.sendFile('index.html'); // SPA fallback
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it('serves a fingerprinted bundle', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('console.log');
  });

  it('serves the web manifest, without which the app cannot be installed', async () => {
    const res = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(res.statusCode).toBe(200);
  });

  it('falls back to index.html for a client-side route', async () => {
    // The service worker opens /?ack=<id> after a notification tap. If this
    // returned 404, acknowledging from a notification would land on an error page.
    const res = await app.inject({ method: 'GET', url: '/?ack=abc' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it('does NOT fall back to index.html for an unknown API route', async () => {
    // An API client must get JSON and a 404, not a page of HTML it cannot parse.
    const res = await app.inject({ method: 'GET', url: '/v1/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('does NOT fall back for an unknown acknowledgement link', async () => {
    const res = await app.inject({ method: 'GET', url: '/a/' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('refuses to serve a file outside the root', async () => {
    // The advisory that prompted the upgrade was a path traversal. Prove it.
    const res = await app.inject({
      method: 'GET',
      url: '/../../../../etc/passwd',
    });
    expect(res.body).not.toContain('root:');
    expect([400, 403, 404, 200]).toContain(res.statusCode);
    // A 200 here would be the SPA fallback returning index.html, which is fine —
    // what must never happen is the file itself coming back.
    if (res.statusCode === 200) expect(res.body).toContain('id="root"');
  });

  it('does not list the directory', async () => {
    // Directory listing is the other half of the advisory. It is off by default;
    // this pins it so nobody switches it on for convenience.
    const res = await app.inject({ method: 'GET', url: '/assets/' });
    expect(res.body).not.toContain('index-abc123.js');
  });
});
