// Global error handler — translates thrown errors into RFC 7807 Problem
// Details responses. Logs full stack but only exposes a safe message to the
// client.

import type { ErrorHandler } from 'hono';
import { AppError, toProblemDetail } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import type { RequestContext } from '../types/domain.ts';

export const errorHandler: ErrorHandler = (err, c) => {
  const ctx = c.get('ctx') as RequestContext | undefined;
  const requestId = ctx?.requestId ?? 'no-request-id';
  const problem = toProblemDetail(err, requestId);

  if (err instanceof AppError && err.status < 500) {
    logger.warn({ err: { name: err.name, msg: err.message }, status: err.status, requestId }, 'app error');
  } else {
    logger.error({ err, requestId }, 'unhandled error');
  }

  return c.json(problem, problem.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503, {
    'content-type': 'application/problem+json',
  });
};
