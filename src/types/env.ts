import { z } from 'zod';

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

  MCP_APPROVAL_BASE_URL: z.string().url(),
  MCP_APPROVAL_INTERNAL_TOKEN: z.string().min(32),

  BACKUP_MASTER_KEY: z.string().min(32),
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
