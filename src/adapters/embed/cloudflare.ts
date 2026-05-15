// Cloudflare Workers AI embedding adapter — bge-m3 multilingual (1024-dim).
//
// Provider: Cloudflare Workers AI (`@cf/baai/bge-m3`).
// Wrapping: optional via Cloudflare AI Gateway for caching / audit / rate-limit.
// Auth: scoped API-Token in `Authorization: Bearer …` header.
//
// PII-masking is applied BEFORE the API call (same contract as the Vertex
// adapter — see PLAN §3.4).
//
// URL forms:
//   Direct       https://api.cloudflare.com/client/v4/accounts/<acc>/ai/run/<model>
//   AI Gateway   https://gateway.ai.cloudflare.com/v1/<acc>/<gateway_id>/workers-ai/<model>
//
// Notes:
//   - bge-m3 is multilingual, dim=1024. The `EmbeddingTaskType` distinction
//     that Vertex makes (RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY) is irrelevant
//     for bge-m3 — same encoder for both. We accept the param for interface
//     compatibility and ignore it here.
//   - bge-m3's Workers-AI endpoint accepts `{ text: string[] }` and returns
//     `{ result: { data: number[][] } }` (per CF docs).

import { loadEnv } from '../../types/env.ts';
import { maskPII } from '../../lib/pii/mask.ts';
import { logger } from '../../lib/logger.ts';
import type { EmbeddingAdapter, EmbeddingTaskType } from './interface.ts';

interface CloudflareWorkersAiResponse {
  result?: { data?: number[][] };
  success?: boolean;
  errors?: { code: number; message: string }[];
}

export class CloudflareEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string;
  readonly dimensions = 1024;

  constructor(model?: string) {
    this.model = model ?? loadEnv().CLOUDFLARE_AI_MODEL;
  }

  private endpoint(): string {
    const env = loadEnv();
    if (!env.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID not set');
    }
    // Prefer AI Gateway when configured (caching, audit, rate-limit).
    if (env.CLOUDFLARE_AI_GATEWAY_ID) {
      return `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY_ID}/workers-ai/${this.model}`;
    }
    return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${this.model}`;
  }

  async embed(texts: string[], _taskType: EmbeddingTaskType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const env = loadEnv();
    if (!env.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_API_TOKEN not set');
    }
    const masked = texts.map(maskPII);
    const r = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: masked }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '<unreadable>');
      logger.error({ status: r.status, body, model: this.model }, 'cloudflare embed failed');
      throw new Error(`cloudflare embed failed: ${r.status}`);
    }
    const j = (await r.json()) as CloudflareWorkersAiResponse;
    if (!j.success || !j.result?.data) {
      logger.error({ errors: j.errors, model: this.model }, 'cloudflare embed returned non-success');
      throw new Error('cloudflare embed returned non-success response');
    }
    const data = j.result.data;
    if (data.length !== masked.length) {
      throw new Error(`cloudflare embed returned ${data.length} vectors for ${masked.length} inputs`);
    }
    return data;
  }
}
