// /health, /health/ready, /version, /metrics

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { appDbPool } from '../db/client.ts';
import { blobStore } from '../adapters/blob/index.ts';
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
    // Differentiated readiness:
    //   - DB is load-bearing — every request reads/writes Postgres. DB-fail = 503.
    //   - Blob is opportunistic — only object-bodies > 16 KB persist to R2; the
    //     app can serve all metadata + small-body operations without blob.
    //     Blob-fail => status="degraded", but still HTTP 200 so the Fly proxy
    //     keeps routing traffic. Per-operation errors propagate when the blob
    //     path is actually hit.
    const checks: Record<string, string> = {};
    let dbOk = true;
    let blobOk = true;

    try {
      const r = await appDbPool().query('SELECT 1 AS up');
      checks.db = r.rowCount ? 'ok' : 'empty';
    } catch (e) {
      checks.db = `error: ${(e as Error).message}`;
      dbOk = false;
    }

    try {
      // exists() on a sentinel key; missing key still proves blob connectivity
      await blobStore().exists('__health__');
      checks.blob = 'ok';
    } catch (e) {
      checks.blob = `error: ${(e as Error).message}`;
      blobOk = false;
    }

    const status = dbOk ? (blobOk ? 'ready' : 'degraded') : 'down';
    return c.json({ status, checks }, dbOk ? 200 : 503);
  })
  .get('/metrics', async (c) => {
    const body = await metricsText();
    return c.body(body, 200, { 'content-type': 'text/plain; version=0.0.4' });
  });

// Keep `sql` import used in case we extend (placeholder to silence lint until used)
void sql;
