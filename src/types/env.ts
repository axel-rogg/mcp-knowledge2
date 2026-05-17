import { z } from 'zod';

/**
 * Try to decode a string as base64; if that produces ≠ 32 bytes, try hex.
 * Returns the 32-byte buffer or null on failure.
 *
 * Exported so runtime callers (e.g. backup.ts) decode the same shape that
 * env-validation accepts.
 */
export function decodeKey(s: string): Buffer | null {
  // Hex: 64 ascii chars, [0-9a-fA-F] only
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, 'hex');
  }
  // Base64 (padded or unpadded): try and validate the round-trip
  try {
    const b = Buffer.from(s, 'base64');
    if (b.toString('base64').replace(/=+$/, '') === s.replace(/=+$/, '')) {
      return b;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  DATABASE_ADMIN_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

  // AS-3 K13 multi-issuer JWT. The JWT verifier (K5) accepts tokens from:
  //   * Google OIDC (https://accounts.google.com) — for tokens passed
  //     directly to KC2 (rare, normally approval2 fronts).
  //   * KC2's own facade (SELF_OAUTH_ISSUER) — issued by /oauth/token.
  // JWKS for Google is the well-known endpoint; JWKS for self is in-process.
  JWKS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  // OAuth-facade (K3/K4): KC2 issues its own MCP-client tokens.
  SELF_OAUTH_ISSUER: z.string().url(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  // Single-value fallback (cron-context, legacy clients). Live OAuth flow
  // derives `redirect_uri` from request-origin via resolveOrigin() to support
  // Coop-Bypass via fly.dev URL (PLAN-coop-bypass-fly-dev §3.3 Option B).
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  // Allowlist of legitimate origins for this service (scheme://host[:port],
  // https only). Used by resolveOrigin() to validate request-origins against
  // Host-Header-Spoofing. Empty (default) = single-origin mode (= origin of
  // SELF_OAUTH_ISSUER). CSV. New 2026-05-17 for Coop-fly.dev bypass.
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
    .refine((arr) => arr.every((o) => /^https:\/\//.test(o)), 'must be https URLs'),
  // Optional Workspace-domain allowlist (K-D1). CSV — empty = all domains ok.
  GOOGLE_HD_ALLOWLIST: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  // Email-allowlist for OAuth-login enforcement. CSV — empty = open (any
  // Google-verified email accepted). Non-empty = strict whitelist: only the
  // listed emails may complete the OAuth callback. Compared lower-case after
  // trim, to absorb Gmail-style casing. Defense-in-depth: stricter than the
  // OAuth-app's own Test-Users list in Google Cloud Console.
  ALLOWED_EMAILS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
  GOOGLE_JWKS_URL: z.string().url().default('https://www.googleapis.com/oauth2/v3/certs'),
  GOOGLE_ISSUER: z.string().default('https://accounts.google.com'),

  // OBO (K7): approval2 forwards calls with a signed JWT from its facade.
  // Optional — when unset, the OBO middleware refuses (no proxy mode).
  MCP_APPROVAL_JWKS_URL: z.string().url().optional(),
  MCP_APPROVAL_ISSUER: z.string().default('mcp-approval2'),

  SERVICE_TOKEN: z.string().min(32),

  // ── Blob storage ──────────────────────────────────────────────────
  // Default 's3' covers AWS S3, Cloudflare R2, Backblaze B2, Hetzner OS,
  // MinIO. 'gcs' is the native Google Cloud Storage path via Workload
  // Identity Federation (no HMAC keys) — used by the business workspace.
  BLOB_PROVIDER: z.enum(['s3', 'gcs']).default('s3'),
  BLOB_BUCKET: z.string().min(1),

  // S3-path config — only required when BLOB_PROVIDER='s3'
  BLOB_ENDPOINT: z.string().url().optional(),
  BLOB_REGION: z.string().min(1).default('eu-central'),
  BLOB_ACCESS_KEY: z.string().min(1).optional(),
  BLOB_SECRET_KEY: z.string().min(1).optional(),
  BLOB_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // GCS-path config — only required when BLOB_PROVIDER='gcs'
  GCS_PROJECT_ID: z.string().min(1).optional(),
  GCS_KEY_FILE: z.string().min(1).optional(), // local-dev only; Workload Identity in prod

  // ── Embedding provider selection ──────────────────────────────────
  // Default: 'cloudflare' (Workers AI via AI Gateway, bge-m3 multilingual,
  // 1024-dim). 'vertex' kept as fallback for migration / parity testing.
  EMBED_PROVIDER: z.enum(['cloudflare', 'vertex']).default('cloudflare'),

  // ── Vertex AI (legacy, kept for fallback) ─────────────────────────
  // Only required when EMBED_PROVIDER='vertex'; optional otherwise so the
  // service can boot without Google Cloud credentials.
  VERTEX_PROJECT: z.string().min(1).optional(),
  VERTEX_LOCATION: z.string().min(1).default('europe-west4'),
  VERTEX_MODEL: z.string().min(1).default('text-multilingual-embedding-002'),
  // Three auth modes (tried in this order):
  //   1. VERTEX_SERVICE_ACCOUNT_JSON      — inline SA JSON (Fly/Hetzner secret)
  //   2. VERTEX_SERVICE_ACCOUNT_JSON_PATH — file mount (k8s/local dev)
  //   3. Neither set                      — ADC via metadata server
  //                                         (Cloud Run / GCE / GKE Workload-Identity)
  VERTEX_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  VERTEX_SERVICE_ACCOUNT_JSON_PATH: z.string().min(1).optional(),

  // ── Cloudflare Workers AI + optional AI Gateway ───────────────────
  // Only required when EMBED_PROVIDER='cloudflare' (the default). API-token
  // needs scopes: Workers AI Read + AI Gateway Run (if Gateway used).
  // When CLOUDFLARE_AI_GATEWAY_ID is set, traffic goes via AI Gateway URL
  // (caching, audit, rate-limit); otherwise direct to Workers AI.
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_AI_GATEWAY_ID: z.string().min(1).optional(),
  // Optional. Required only when the AI Gateway runs in "Authenticated"
  // mode — sent as `cf-aig-authorization: Bearer <token>` in addition to
  // the Workers-AI bearer. Without it, an Authenticated Gateway rejects
  // every request with `10000 Authentication error`.
  CLOUDFLARE_AI_GATEWAY_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_AI_MODEL: z.string().min(1).default('@cf/baai/bge-m3'),

  // AS-3 K9/K13: KMS provider selection.
  //   - 'openbao'    — Hetzner pilot, Transit-Engine via OPENBAO_ADDR/TOKEN
  //   - 'cloud_kms'  — GCP business, Cloud-KMS-wrapped master + HKDF derive
  //   - 'hkdf_local' — dev/solo fallback, derive DEK from KMS_MASTER_KEY_B64
  KMS_PROVIDER: z.enum(['openbao', 'cloud_kms', 'hkdf_local']).default('hkdf_local'),
  OPENBAO_ADDR: z.string().url().optional(),
  OPENBAO_TOKEN: z.string().optional(),
  OPENBAO_TRANSIT_PATH: z.string().default('transit'),
  KMS_MASTER_KEY_B64: z.string().optional(),

  // Cloud-KMS config — only required when KMS_PROVIDER='cloud_kms'
  //   CLOUD_KMS_KEY_NAME: projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>
  //   CLOUD_KMS_WRAPPED_MASTER_B64: base64-ciphertext from Cloud-KMS encrypt
  //     of a fresh 32-byte master key. Re-issue + Doppler-update + restart
  //     to rotate.
  CLOUD_KMS_KEY_NAME: z.string().min(1).optional(),
  CLOUD_KMS_WRAPPED_MASTER_B64: z.string().min(1).optional(),
  // Optional inline SA-JSON für Cloud-KMS-Auth — analog Pattern in
  // mcp-approval2's CloudKmsKekProvider. Wenn gesetzt, wird direkt an
  // KeyManagementServiceClient.credentials uebergeben. Wenn nicht
  // gesetzt: default ADC-Chain (GOOGLE_APPLICATION_CREDENTIALS file-path
  // oder Metadata-Server). Auf Fly via TF-Apply als doppler_secret
  // gepushed (terraform/environments/privat/gcp-kms.tf).
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().min(1).optional(),

  // F-21: must decode to exactly 32 raw bytes for AES-256-GCM. Hex (64 ascii)
  // and base64 (44 ascii padded) are both fine — we accept either by
  // sniffing on shape, then validate the decoded length. Catches the common
  // misconfiguration of "I generated a 32-char hex string" (= 16 bytes).
  BACKUP_MASTER_KEY: z
    .string()
    .min(32)
    .refine(
      (s) => {
        const decoded = decodeKey(s);
        return decoded !== null && decoded.length === 32;
      },
      'BACKUP_MASTER_KEY must decode (base64 or hex) to exactly 32 bytes',
    ),
  BACKUP_BUCKET: z.string().min(1).optional(),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const formatted = parsed.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCacheForTest(): void {
  cached = null;
}
