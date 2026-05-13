// Vertex AI embedding adapter — text-embedding-005, EU-region.
//
// Auth: service-account JSON (Self-Host) or workload-identity (GCP-Native).
// PII-masking is applied BEFORE the API call (PLAN §3.4).

import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { loadEnv } from '../../types/env.ts';
import { maskPII } from '../../lib/pii/mask.ts';
import { logger } from '../../lib/logger.ts';
import type { EmbeddingAdapter, EmbeddingTaskType } from './interface.ts';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

let cachedSa: ServiceAccount | null = null;
let cachedAccessToken: { token: string; exp: number } | null = null;

async function loadServiceAccount(): Promise<ServiceAccount> {
  if (cachedSa) return cachedSa;
  const env = loadEnv();
  const path = env.VERTEX_SERVICE_ACCOUNT_JSON_PATH;
  if (!path) {
    throw new Error('VERTEX_SERVICE_ACCOUNT_JSON_PATH not set');
  }
  const raw = await readFile(path, 'utf8');
  cachedSa = JSON.parse(raw) as ServiceAccount;
  return cachedSa;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.exp > now + 60) {
    return cachedAccessToken.token;
  }
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
    const masked = texts.map(maskPII);
    const url = `https://${env.VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.VERTEX_PROJECT}/locations/${env.VERTEX_LOCATION}/publishers/google/models/${this.model}:predict`;

    const token = await getAccessToken();
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        instances: masked.map((t) => ({ content: t, task_type: taskType })),
        parameters: { outputDimensionality: this.dimensions },
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      logger.error({ status: r.status, body }, 'vertex embed failed');
      throw new Error(`vertex embed failed: ${r.status}`);
    }
    const j = (await r.json()) as {
      predictions: { embeddings: { values: number[] } }[];
    };
    return j.predictions.map((p) => p.embeddings.values);
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
