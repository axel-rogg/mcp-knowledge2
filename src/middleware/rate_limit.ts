// In-process sliding-window rate limiter — for public routes that don't
// have any other auth gate (DCR, OAuth-authorize, OAuth-callback).
//
// Defense-in-depth on top of CF-Ruleset (terraform-managed) — CF blocks
// most spam at the edge, this middleware catches the rest if CF-Proxy is
// disabled or bypassed (direct *.fly.dev hit).
//
// Properties:
//   - Sliding window (not bucket) — fair to bursty legit clients
//   - Per-IP keyed (resolved from X-Forwarded-For / Cf-Connecting-Ip /
//     Fly-Client-Ip in that priority; falls back to "unknown" if none set)
//   - In-memory only — fine for single-machine Fly deploy. Multi-instance
//     would need Redis-backed store; not in pilot scope.
//   - Auto-cleanup: each insert prunes timestamps older than the window
//   - 429 with Retry-After header on exceed
//
// Spec: docs/STRATEGIE-pilot.md §"Was offen / nicht abgedeckt ist" +
//       docs/plans/active/PLAN-hardening.md.

import type { MiddlewareHandler } from 'hono';
import { errTooManyRequests } from '../lib/errors.ts';
import type { RequestContext } from '../types/domain.ts';

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /** Logical bucket name, used in error detail. */
  name: string;
  /**
   * Optional key-resolver — default = IP-based. SEC-K-018: für authentifizierte
   * Routes liefert userKeyResolver(c) den ctx.userId als Bucket-Key, sodass
   * approval2-Egress-IPs nicht per-IP geteilt werden (alle approval2-Calls
   * teilen sich die EINE IP).
   */
  keyResolver?: (c: Parameters<MiddlewareHandler>[0]) => string;
}

/**
 * Resolve the caller IP from Fly + Cloudflare + standard headers.
 * Returns "unknown" if no header is present (e.g. local dev curl).
 */
function resolveClientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const flyIp = c.req.header('fly-client-ip');
  if (flyIp) return flyIp.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    // X-Forwarded-For = "client, proxy1, proxy2" — take the leftmost.
    const first = xff.split(',')[0];
    if (first) return first.trim();
  }
  return 'unknown';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  // Module-scoped store. One Map per limiter-instance, so different routes
  // (e.g. /oauth/register vs /oauth/authorize) don't share counters.
  const store = new Map<string, number[]>();
  const keyOf = opts.keyResolver ?? resolveClientIp;

  return async (c, next) => {
    const ip = keyOf(c);
    const now = Date.now();
    const windowStart = now - opts.windowMs;

    const existing = store.get(ip) ?? [];
    // Drop timestamps outside the window.
    const fresh = existing.filter((ts) => ts > windowStart);

    if (fresh.length >= opts.max) {
      // Compute Retry-After from the oldest timestamp in the window.
      const oldest = fresh[0]!;
      const retryAfterMs = Math.max(0, oldest + opts.windowMs - now);
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      throw errTooManyRequests(
        `rate limit exceeded on ${opts.name}: ${opts.max} per ${opts.windowMs}ms`,
        { ip, bucket: opts.name, retry_after_ms: retryAfterMs },
      );
    }

    fresh.push(now);
    store.set(ip, fresh);
    await next();
  };
}

/**
 * SEC-K-018: Per-User-Rate-Limit für authentifizierte Routes (/v1/* + /mcp).
 * Greift erst NACH auth-middleware (sonst ist ctx.userId noch nicht gesetzt).
 * Fallback auf IP wenn ctx fehlt (z.B. early-401-Pfade).
 *
 * Default-Bucket: 600 req/min/user — generös für legit Workflow-Bursts
 * (PWA-Prefetch, batched MCP-tools/list), kappt aber unbounded Loops
 * (Embedding-Cost-Explosion, batched-tools-DoS).
 */
export function userRateLimit(opts: { windowMs: number; max: number; name: string }): MiddlewareHandler {
  return rateLimit({
    ...opts,
    keyResolver: (c) => {
      const ctx = c.get('ctx') as RequestContext | undefined;
      if (ctx?.userId) return `user:${ctx.userId}`;
      // Fallback auf IP fuer not-yet-auth'd Calls. Trennt user-keyed buckets
      // sauber von ip-keyed (different namespace).
      return `ip:${resolveClientIp(c)}`;
    },
  });
}

/**
 * Test-only: clear all per-IP counters. Vitest calls this between cases.
 */
export function resetRateLimitForTest(_handler: MiddlewareHandler): void {
  // The closure-scoped `store` Map is not directly accessible from outside.
  // For tests we instantiate fresh limiters per case instead — see
  // tests/unit/rate_limit.test.ts. This helper exists as a documentation
  // anchor and reserved hook for future Redis-backed implementations.
  void _handler;
}
