// Per-request structured log line. Does NOT log request bodies, search
// queries, authorization headers, or response bodies (see lib/logger redact
// rules).

import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.ts';
import type { RequestContext } from '../types/domain.ts';

export const requestLog: MiddlewareHandler = async (c, next) => {
  const start = process.hrtime.bigint();
  await next();
  const ctx = c.get('ctx') as RequestContext | undefined;
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  logger.info(
    {
      path: c.req.path,
      method: c.req.method,
      status: c.res.status,
      duration_ms: Number(durationMs.toFixed(2)),
      user_id: ctx?.userId ?? null,
      request_id: ctx?.requestId ?? null,
      auth_mode: ctx?.authMode ?? null,
    },
    'request',
  );
};
