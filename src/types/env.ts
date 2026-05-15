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

  JWKS_URL: z.string().url(),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWKS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  SERVICE_TOKEN: z.string().min(32),

  BLOB_ENDPOINT: z.string().url(),
  BLOB_REGION: z.string().min(1).default('eu-central'),
  BLOB_ACCESS_KEY: z.string().min(1),
  BLOB_SECRET_KEY: z.string().min(1),
  BLOB_BUCKET: z.string().min(1),
  BLOB_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  VERTEX_PROJECT: z.string().min(1),
  VERTEX_LOCATION: z.string().min(1).default('europe-west4'),
  VERTEX_MODEL: z.string().min(1).default('text-embedding-005'),
  VERTEX_SERVICE_ACCOUNT_JSON_PATH: z.string().min(1).optional(),

  // AS-3 K9/K13: KMS provider selection.
  //   - 'openbao'    — prod default, Transit-Engine via OPENBAO_ADDR/TOKEN
  //   - 'hkdf_local' — dev/solo fallback, derive DEK from KMS_MASTER_KEY_B64
  KMS_PROVIDER: z.enum(['openbao', 'hkdf_local']).default('hkdf_local'),
  OPENBAO_ADDR: z.string().url().optional(),
  OPENBAO_TOKEN: z.string().optional(),
  OPENBAO_TRANSIT_PATH: z.string().default('transit'),
  KMS_MASTER_KEY_B64: z.string().optional(),

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
