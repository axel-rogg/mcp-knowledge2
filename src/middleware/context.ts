// Wraps the request handler in AsyncLocalStorage so storage layer functions
// can read the current user/request id without explicit threading.

import type { MiddlewareHandler } from 'hono';
import { withContext } from '../lib/context.ts';
import type { RequestContext } from '../types/domain.ts';

export const installContext: MiddlewareHandler = async (c, next) => {
  const ctx = c.get('ctx') as RequestContext | undefined;
  if (!ctx) {
    // routes that don't auth (e.g. /health) never set ctx; just pass through
    await next();
    return;
  }
  await withContext(ctx, async () => {
    await next();
  });
};
