import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { rateLimit } from '../../src/middleware/rate_limit.ts';
import { AppError } from '../../src/lib/errors.ts';

function makeApp(opts: { windowMs: number; max: number; name: string }) {
  const app = new Hono();
  app.use('/limited', rateLimit(opts));
  app.get('/limited', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, status: err.status, extra: err.extra },
        err.status as ContentfulStatusCode,
      );
    }
    return c.json({ error: 'unknown' }, 500);
  });
  return app;
}

function req(ip: string) {
  return new Request('http://localhost/limited', {
    headers: { 'cf-connecting-ip': ip },
  });
}

describe('rateLimit middleware', () => {
  it('lets requests through under the limit', async () => {
    const app = makeApp({ windowMs: 60_000, max: 3, name: 'test' });
    for (let i = 0; i < 3; i++) {
      const r = await app.fetch(req('1.2.3.4'));
      expect(r.status).toBe(200);
    }
  });

  it('blocks the (max+1)th request with 429 + Retry-After', async () => {
    const app = makeApp({ windowMs: 60_000, max: 2, name: 'test' });
    await app.fetch(req('9.9.9.9'));
    await app.fetch(req('9.9.9.9'));
    const blocked = await app.fetch(req('9.9.9.9'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = await blocked.json() as { extra?: { bucket?: string; ip?: string } };
    expect(body.extra?.bucket).toBe('test');
    expect(body.extra?.ip).toBe('9.9.9.9');
  });

  it('isolates counters per IP', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, name: 'test' });
    expect((await app.fetch(req('5.5.5.5'))).status).toBe(200);
    expect((await app.fetch(req('5.5.5.5'))).status).toBe(429);
    expect((await app.fetch(req('6.6.6.6'))).status).toBe(200);
  });

  it('falls back to "unknown" when no IP header is present', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, name: 'test' });
    const r1 = await app.fetch(new Request('http://localhost/limited'));
    expect(r1.status).toBe(200);
    const r2 = await app.fetch(new Request('http://localhost/limited'));
    expect(r2.status).toBe(429);
    const body = await r2.json() as { extra?: { ip?: string } };
    expect(body.extra?.ip).toBe('unknown');
  });

  it('header priority: cf-connecting-ip > fly-client-ip > x-forwarded-for', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, name: 'test' });
    // First call: only X-Forwarded-For set → IP = "1.1.1.1"
    const r1 = await app.fetch(new Request('http://localhost/limited', {
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    }));
    expect(r1.status).toBe(200);
    // Second call: same X-Forwarded-For → blocked
    const r2 = await app.fetch(new Request('http://localhost/limited', {
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    }));
    expect(r2.status).toBe(429);
    // Third call: cf-connecting-ip overrides X-Forwarded-For → new bucket
    const r3 = await app.fetch(new Request('http://localhost/limited', {
      headers: { 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '8.8.8.8' },
    }));
    expect(r3.status).toBe(200);
  });

  it('sliding window: old timestamps expire', async () => {
    const app = makeApp({ windowMs: 50, max: 1, name: 'test' });
    expect((await app.fetch(req('7.7.7.7'))).status).toBe(200);
    expect((await app.fetch(req('7.7.7.7'))).status).toBe(429);
    await new Promise((r) => setTimeout(r, 60));
    expect((await app.fetch(req('7.7.7.7'))).status).toBe(200);
  });
});
