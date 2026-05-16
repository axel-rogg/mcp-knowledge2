// RFC 7807 Problem Details + typed application errors.
// Routes throw these; the error-middleware translates to JSON responses.

export interface ProblemDetail {
  type: string; // URI reference, e.g. 'about:blank' or 'https://docs/.../quota-exceeded'
  title: string;
  status: number;
  detail?: string;
  instance?: string; // request_id
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly type: string;
  readonly extra?: Record<string, unknown>;

  constructor(status: number, type: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.type = type;
    this.extra = extra ?? undefined;
  }
}

export const errBadRequest = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(400, 'https://problems.knowledge2/bad-request', detail, extra);

export const errUnauthorized = (detail: string) =>
  new AppError(401, 'https://problems.knowledge2/unauthorized', detail);

export const errForbidden = (detail: string) =>
  new AppError(403, 'https://problems.knowledge2/forbidden', detail);

export const errNotFound = (detail: string) =>
  new AppError(404, 'https://problems.knowledge2/not-found', detail);

export const errConflict = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(409, 'https://problems.knowledge2/conflict', detail, extra);

export const errQuotaExceeded = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(429, 'https://problems.knowledge2/quota-exceeded', detail, extra);

export const errTooManyRequests = (detail: string, extra?: Record<string, unknown>) =>
  new AppError(429, 'https://problems.knowledge2/too-many-requests', detail, extra);

export const errInternal = (detail: string) =>
  new AppError(500, 'about:blank', detail);

export const errServiceUnavailable = (detail: string) =>
  new AppError(503, 'https://problems.knowledge2/service-unavailable', detail);

export function toProblemDetail(err: unknown, instance: string): ProblemDetail {
  if (err instanceof AppError) {
    return {
      type: err.type,
      title: err.message,
      status: err.status,
      instance,
      ...(err.extra ?? {}),
    };
  }
  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    instance,
  };
}
