// Multi-Origin support for the OAuth-facade (Coop-Bypass via fly.dev URL).
//
// Spec: mcp-approval2/docs/plans/active/PLAN-coop-bypass-fly-dev.md §3.3 (Option B).
//
// Background: KC2 ist seit AS-3 als autonomer MCP-Server betreibbar (eigene
// DCR-Facade + /oauth/authorize + Google-IdP-Redirect + /mcp). User braucht
// für Coop-Netz-Zugriff (Zscaler blockt `*.ai-toolhub.org`, lässt `*.fly.dev`
// durch) eine alternative Origin-URL die dieselbe Service-Surface bedient.
//
// Statisches GOOGLE_OAUTH_REDIRECT_URI (single-value env) reicht nicht, weil
// dann nur EIN Origin korrekt funktioniert. Wir derivieren `redirect_uri` zur
// Laufzeit aus der Request-Origin, validiert gegen ALLOWED_ORIGINS-Allowlist
// (Anti-Spoofing).
//
// Cron-Kontext (kein Request): SELF_OAUTH_ISSUER ist canonical fallback.

import type { Env } from '../types/env.ts';

export interface OriginEnvSlice {
  readonly ALLOWED_ORIGINS: ReadonlyArray<string>;
  readonly SELF_OAUTH_ISSUER: string;
}

/**
 * Resolve the canonical origin (scheme + host[:port], no path) for this
 * request. Honors Fly's `X-Forwarded-*` headers (TLS terminates at the
 * proxy). Validates against allowlist before returning the request-origin —
 * unknown origins fall back to SELF_OAUTH_ISSUER to prevent open-redirect
 * abuse if a caller spoofs the Host header against the app's bare port.
 *
 * Examples (with ALLOWED_ORIGINS=[`https://knowledge2.ai-toolhub.org`,`https://mcp-knowledge2.fly.dev`]):
 * - Request from `mcp-knowledge2.fly.dev` → `https://mcp-knowledge2.fly.dev`
 * - Request from `knowledge2.ai-toolhub.org` → `https://knowledge2.ai-toolhub.org`
 * - Request from `evil.attacker.com` (with spoofed Host) → SELF_OAUTH_ISSUER fallback
 */
export function resolveOrigin(request: Request | null, env: OriginEnvSlice): string {
  const fallback = new URL(env.SELF_OAUTH_ISSUER).origin;
  if (!request) return fallback;

  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https';

  let candidate: string;
  if (forwardedHost) {
    candidate = `${forwardedProto}://${forwardedHost}`;
  } else {
    try {
      candidate = new URL(request.url).origin;
    } catch {
      return fallback;
    }
  }

  const allowed = new Set<string>([fallback, ...env.ALLOWED_ORIGINS]);
  if (!allowed.has(candidate)) {
    return fallback;
  }
  return candidate;
}

/** Build the Google OAuth callback URL for a given origin. */
export function buildRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, '')}/auth/google/callback`;
}
