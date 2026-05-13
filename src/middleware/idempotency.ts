// Idempotency middleware. Reads `Idempotency-Key` header; if present and the
// (user_id, idem_key) is cached, returns the recorded response. Otherwise
// runs the handler and records the response body+status for the TTL.

import type { MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { idempotencyRecords } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { nowMs } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';
import type { RequestContext } from '../types/domain.ts';

const IDEM_TTL_MS = 24 * 60 * 60 * 1000;

export const idempotency: MiddlewareHandler = async (c, next) => {
  const idemKey = c.req.header('idempotency-key');
  if (!idemKey) {
    await next();
    return;
  }
  const ctx = c.get('ctx') as RequestContext | undefined;
  if (!ctx?.userId) {
    await next();
    return;
  }
  const method = c.req.method;
  // Only POST/PUT/PATCH are idempotent-cacheable
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    await next();
    return;
  }

  // 1. Check cache
  const cached = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .select()
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.userId, ctx.userId!), eq(idempotencyRecords.idemKey, idemKey)))
      .limit(1);
    return r[0] ?? null;
  });

  if (cached) {
    if (cached.expiresAt < nowMs()) {
      logger.debug({ idemKey }, 'idem record expired, re-executing');
    } else if (cached.responseBody && cached.responseStatus) {
      const text = Buffer.from(cached.responseBody).toString('utf8');
      return new Response(text, {
        status: cached.responseStatus,
        headers: {
          'content-type': 'application/json',
          'x-idempotent-replay': 'true',
        },
      });
    }
  }

  await next();

  // 2. Cache successful 2xx responses only
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    try {
      const cloned = c.res.clone();
      const text = await cloned.text();
      const buf = new Uint8Array(Buffer.from(text, 'utf8'));
      await withUserTx(ctx.userId, ctx.requestId, async (db) => {
        await db
          .insert(idempotencyRecords)
          .values({
            userId: ctx.userId!,
            idemKey,
            responseBody: buf,
            responseStatus: status,
            createdAt: nowMs(),
            expiresAt: nowMs() + IDEM_TTL_MS,
          })
          .onConflictDoNothing();
      });
    } catch (e) {
      logger.warn({ err: e, idemKey }, 'failed to record idempotency entry');
    }
  }
  return;
};
