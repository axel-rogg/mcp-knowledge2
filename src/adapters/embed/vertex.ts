// Vertex AI embedding adapter — text-multilingual-embedding-002, EU-region.
//
// Auth modes (tried in this order):
//   1. VERTEX_SERVICE_ACCOUNT_JSON       — inline SA JSON (Fly/Hetzner secret)
//   2. VERTEX_SERVICE_ACCOUNT_JSON_PATH  — file mount (k8s, local dev)
//   3. ADC via metadata server           — Cloud Run / GCE / GKE Workload-Identity
//
// PII-masking is applied BEFORE the API call (PLAN §3.4).

import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { loadEnv } from '../../types/env.ts';
import { maskPII } from '../../lib/pii/mask.ts';
import { logger } from '../../lib/logger.ts';
import { retryWithBackoff } from '../../lib/retry.ts';
import type { EmbeddingAdapter, EmbeddingTaskType } from './interface.ts';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

type AuthMode = 'sa-json' | 'sa-file' | 'adc';

let cachedSa: ServiceAccount | null = null;
let cachedAuthMode: AuthMode | null = null;
let cachedAccessToken: { token: string; exp: number } | null = null;

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

function resolveAuthMode(): AuthMode {
  if (cachedAuthMode) return cachedAuthMode;
  const env = loadEnv();
  if (env.VERTEX_SERVICE_ACCOUNT_JSON) cachedAuthMode = 'sa-json';
  else if (env.VERTEX_SERVICE_ACCOUNT_JSON_PATH) cachedAuthMode = 'sa-file';
  else cachedAuthMode = 'adc';
  return cachedAuthMode;
}

async function loadServiceAccount(): Promise<ServiceAccount> {
  if (cachedSa) return cachedSa;
  const env = loadEnv();
  let raw: string;
  if (env.VERTEX_SERVICE_ACCOUNT_JSON) {
    raw = env.VERTEX_SERVICE_ACCOUNT_JSON;
  } else if (env.VERTEX_SERVICE_ACCOUNT_JSON_PATH) {
    raw = await readFile(env.VERTEX_SERVICE_ACCOUNT_JSON_PATH, 'utf8');
  } else {
    throw new Error(
      'Vertex SA load called without VERTEX_SERVICE_ACCOUNT_JSON or _PATH set; ADC mode should not reach this',
    );
  }
  cachedSa = JSON.parse(raw) as ServiceAccount;
  return cachedSa;
}

async function getAccessTokenViaSa(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sa = await loadServiceAccount();
  const iat = now;
  const exp = now + 3600;
  const header = base64url(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'sa-key' }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: sa.token_uri,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key);
  const jwt = `${signingInput}.${signature.toString('base64url')}`;

  const r = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!r.ok) {
    throw new Error(`Vertex token-exchange failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = { token: j.access_token, exp: now + j.expires_in };
  return j.access_token;
}

async function getAccessTokenViaAdc(): Promise<string> {
  // Cloud Run / GCE / GKE Workload-Identity expose the active SA's bearer
  // token at the metadata endpoint. Fast (<10ms warm), no signing math.
  const now = Math.floor(Date.now() / 1000);
  const r = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!r.ok) {
    throw new Error(
      `ADC metadata-server token fetch failed: ${r.status} ${await r.text()} ` +
        `(running outside Cloud Run/GCE? Set VERTEX_SERVICE_ACCOUNT_JSON instead.)`,
    );
  }
  const j = (await r.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };
  cachedAccessToken = { token: j.access_token, exp: now + j.expires_in };
  return j.access_token;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.exp > now + 60) {
    return cachedAccessToken.token;
  }
  return resolveAuthMode() === 'adc' ? getAccessTokenViaAdc() : getAccessTokenViaSa();
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export class VertexEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string;
  readonly dimensions = 768;

  constructor(model?: string) {
    this.model = model ?? loadEnv().VERTEX_MODEL;
  }

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const env = loadEnv();
    if (!env.VERTEX_PROJECT) {
      throw new Error('VERTEX_PROJECT not set (required when EMBED_PROVIDER=vertex)');
    }
    const masked = texts.map(maskPII);
    const url = `https://${env.VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.VERTEX_PROJECT}/locations/${env.VERTEX_LOCATION}/publishers/google/models/${this.model}:predict`;
    const dims = this.dimensions;

    // Retry only on 5xx / 429 / network errors. 4xx (bad auth, bad input)
    // is deterministic — don't double the cost.
    return retryWithBackoff(
      async () => {
        const token = await getAccessToken();
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            instances: masked.map((t) => ({ content: t, task_type: taskType })),
            parameters: { outputDimensionality: dims },
          }),
        });
        if (!r.ok) {
          const body = await r.text();
          logger.error({ status: r.status, body }, 'vertex embed failed');
          throw new VertexEmbedError(r.status, `vertex embed failed: ${r.status}`);
        }
        const j = (await r.json()) as {
          predictions: { embeddings: { values: number[] } }[];
        };
        return j.predictions.map((p) => p.embeddings.values);
      },
      {
        maxAttempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 4_000,
        totalBudgetMs: 25_000,
        onRetry: (attempt, err, delayMs) =>
          logger.warn(
            { attempt, delayMs, err: (err as Error).message },
            'vertex embed retrying',
          ),
      },
    );
  }
}

class VertexEmbedError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'VertexEmbedError';
    this.status = status;
  }
}

let cached: EmbeddingAdapter | null = null;
export function embeddingAdapter(): EmbeddingAdapter {
  if (!cached) cached = new VertexEmbeddingAdapter();
  return cached;
}

/**
 * Override the cached embedding adapter. Tests use this to inject a
 * deterministic stub so we don't hit a real Vertex endpoint.
 */
export function setEmbeddingAdapterForTest(impl: EmbeddingAdapter | null): void {
  cached = impl;
}

/** Reset module-local caches. Tests only. */
export function resetVertexCachesForTest(): void {
  cachedSa = null;
  cachedAuthMode = null;
  cachedAccessToken = null;
}
