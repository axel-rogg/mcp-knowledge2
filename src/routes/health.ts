// /health, /health/ready, /version, /metrics

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { appDbPool } from '../db/client.ts';
import { blobStore } from '../adapters/blob/s3.ts';
import { metricsText } from '../observability/metrics.ts';

const VERSION = process.env.npm_package_version ?? '0.1.0';
const BUILD_SHA = process.env.BUILD_SHA ?? 'dev';

export const healthRouter = new Hono()
  .get('/health', (c) => c.json({ status: 'ok' }))
  .get('/version', (c) =>
    c.json({
      version: VERSION,
      build: BUILD_SHA,
      node: process.version,
      service: 'mcp-knowledge2',
    }),
  )
  .get('/health/ready', async (c) => {
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      const r = await appDbPool().query('SELECT 1 AS up');
      checks.db = r.rowCount ? 'ok' : 'empty';
    } catch (e) {
      checks.db = `error: ${(e as Error).message}`;
      ok = false;
    }

    try {
      // exists() on a sentinel key; missing key still proves blob connectivity
      await blobStore().exists('__health__');
      checks.blob = 'ok';
    } catch (e) {
      checks.blob = `error: ${(e as Error).message}`;
      ok = false;
    }

    return c.json({ status: ok ? 'ready' : 'degraded', checks }, ok ? 200 : 503);
  })
  .get('/metrics', async (c) => {
    const body = await metricsText();
    return c.body(body, 200, { 'content-type': 'text/plain; version=0.0.4' });
  });

// Keep `sql` import used in case we extend (placeholder to silence lint until used)
void sql;
