import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadEnv } from './types/env.ts';
import { logger } from './lib/logger.ts';
import { errorHandler } from './middleware/error.ts';
import { installContext } from './middleware/context.ts';
import { idempotency } from './middleware/idempotency.ts';
import { userRateLimit } from './middleware/rate_limit.ts';
import { requestLog } from './middleware/request_log.ts';
import { requireJwtOrOnBehalfOf } from './auth/require_jwt_or_obo.ts';
import { requireServiceToken } from './auth/service_token.ts';
import { healthRouter } from './routes/health.ts';
import { objectsRouter } from './routes/objects.ts';
import { sharesRouter } from './routes/shares.ts';
import { searchRouter } from './routes/search.ts';
import { uploadsRouter } from './routes/uploads.ts';
import { internalRouter } from './routes/internal.ts';
import { oauthFacadeRouter } from './auth/oauth_facade/index.ts';
import { mcpRouter } from './mcp/server.ts';
import { registerAllTools } from './mcp/register_tools.ts';
import { startCrons, stopCrons } from './crons/runner.ts';
import { closeDbPools } from './db/client.ts';
import { httpRequestCounter, httpRequestDuration } from './observability/metrics.ts';

// node-server isn't a direct dependency yet — install via npm i @hono/node-server
// (kept inline because pg-boss installs node-postgres which we already pull in)

const app = new Hono();

app.use('*', async (c, next) => {
  const start = process.hrtime.bigint();
  await next();
  const dur = Number(process.hrtime.bigint() - start) / 1e9;
  const labels = { method: c.req.method, path: c.req.routePath ?? c.req.path, status: String(c.res.status) };
  httpRequestCounter.inc(labels);
  httpRequestDuration.observe({ method: labels.method, path: labels.path }, dur);
});

app.use('*', requestLog);
app.use('*', cors({ origin: '*', credentials: false, maxAge: 86400 }));

// F-2 hardening: any single JSON request body capped at 64 KB. Large
// uploads MUST use the presigned-upload pipeline (POST /v1/uploads/init).
// 64 KB is plenty for inline-body (≤16 KB) plus metadata.
app.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        {
          type: 'https://problems.knowledge2/body-too-large',
          title: 'Request body too large',
          status: 413,
          detail: 'request body exceeded 64 KB; use /v1/uploads for large payloads',
        },
        413,
        { 'content-type': 'application/problem+json' },
      ),
  }),
);

app.onError(errorHandler);
app.notFound((c) =>
  c.json(
    {
      type: 'https://problems.knowledge2/not-found',
      title: 'Not Found',
      status: 404,
      detail: `no route for ${c.req.method} ${c.req.path}`,
    },
    404,
    { 'content-type': 'application/problem+json' },
  ),
);

// ─── Public ────────────────────────────────────────────────────────────────
app.route('/', healthRouter);

// ─── OAuth-facade (Discovery + DCR + JWKS + /oauth/*) ─────────────────────
// Spec: PLAN-as3-autonomous.md §1.1. Public endpoints — auth happens
// per-endpoint inside the facade (Google-redirect for /authorize, etc.).
app.route('/', oauthFacadeRouter);

// ─── User-Auth: own JWT OR approval2 OBO (AS-3 K8) ─────────────────────────
const v1 = new Hono();
v1.use('*', requireJwtOrOnBehalfOf);
v1.use('*', installContext);
// SEC-K-018: Per-User-Rate-Limit. 600 req/min/user — generös für legit
// Workflow (PWA-Prefetch + batched MCP-Calls + Background-Refresh), kappt
// aber Embedding-Loop-DoS und batched-tools-Burn. Geht NACH context-install
// damit ctx.userId verfügbar ist.
v1.use('*', userRateLimit({ windowMs: 60_000, max: 600, name: '/v1' }));
v1.use('*', idempotency);
v1.route('/', objectsRouter);
v1.route('/', sharesRouter);
v1.route('/', searchRouter);
v1.route('/', uploadsRouter);

app.route('/v1', v1);

// ─── Service-Auth (internal) ───────────────────────────────────────────────
const internal = new Hono();
internal.use('*', requireServiceToken);
internal.use('*', installContext);
internal.route('/', internalRouter);

app.route('/v1', internal);

// ─── MCP Streamable-HTTP (AS-3 K10) ────────────────────────────────────────
// Tools are registered on import — see register_tools.ts (K11).
// SEC-K-018: separater Rate-Limit-Bucket fuer /mcp (selbe Per-User-Logik,
// aber eigene Counter — MCP-tools/list-Batches sind eigene Workload).
// Limit 300/min/user — etwas strenger als /v1 weil MCP-Calls oft mehr
// Embedding/Vector-Cost pro Call haben.
registerAllTools();
const mcpScope = new Hono();
mcpScope.use('*', userRateLimit({ windowMs: 60_000, max: 300, name: '/mcp' }));
mcpScope.route('/', mcpRouter);
app.route('/', mcpScope);

// ─── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * SEC-K-003 Hardening: in production muss ENTWEDER ALLOWED_EMAILS gesetzt
 * sein ODER GOOGLE_HD_ALLOWLIST ODER BOOTSTRAP_ADMIN_EMAIL — sonst öffnet
 * provisionFromGoogleLogin im DCR-Pfad eine first-login-admin-Tür für jede
 * Google-verifizierte Email. Im Lockdown-Setup heute zwar nicht public
 * erreichbar, aber defense-in-depth-Boot-Assertion verhindert künftige
 * Lockdown-Regression-Bugs.
 */
function assertProductionAuthGuards(env: ReturnType<typeof loadEnv>): void {
  if (env.NODE_ENV !== 'production') return;
  const hasEmailAllowlist = env.ALLOWED_EMAILS.length > 0;
  const hasHdAllowlist = env.GOOGLE_HD_ALLOWLIST.length > 0;
  const hasBootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL.length > 0;
  if (!hasEmailAllowlist && !hasHdAllowlist && !hasBootstrapEmail) {
    throw new Error(
      'SEC-K-003: NODE_ENV=production but auth-guard env unset. ' +
        'Set at least one of: ALLOWED_EMAILS, GOOGLE_HD_ALLOWLIST, BOOTSTRAP_ADMIN_EMAIL.',
    );
  }
}

async function main() {
  const env = loadEnv();
  assertProductionAuthGuards(env);
  const port = env.PORT;
  // Start the HTTP listener BEFORE pg-boss boots so /health and /version
  // respond immediately on cold-start. pg-boss.start() can take 1-5s against
  // a freshly-attached Postgres, which used to push us past Fly's 10s health
  // grace-period. /health/ready stays the gate for "ready to serve traffic".
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  logger.info({ port, env: env.NODE_ENV }, 'mcp-knowledge2 listening');
  await startCrons();
  logger.info('crons started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await stopCrons();
      await closeDbPools();
      server.close();
    } catch (e) {
      logger.error({ err: e }, 'shutdown error');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  logger.fatal({ err: e }, 'fatal error during boot');
  process.exit(1);
});
