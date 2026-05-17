// Embedding-Adapter Factory — picks provider from env.EMBED_PROVIDER.
//
// Default: 'cloudflare' (Workers AI via AI Gateway, bge-m3 multilingual, 1024-dim).
// Fallback: 'vertex' (Google Vertex AI text-multilingual-embedding-002, 768-dim).
//
// Caller convention: import { embeddingAdapter, setEmbeddingAdapterForTest }
// from this file — NEVER from a concrete provider file. Provider switch is
// env-driven without code edits in callers.

import { loadEnv } from '../../types/env.ts';
import type { EmbeddingAdapter } from './interface.ts';
import { CloudflareEmbeddingAdapter } from './cloudflare.ts';
import { VertexEmbeddingAdapter } from './vertex.ts';

let cached: EmbeddingAdapter | null = null;

export function embeddingAdapter(): EmbeddingAdapter {
  if (cached) return cached;
  const provider = loadEnv().EMBED_PROVIDER;
  switch (provider) {
    case 'cloudflare':
      cached = new CloudflareEmbeddingAdapter();
      break;
    case 'vertex':
      cached = new VertexEmbeddingAdapter();
      break;
    default: {
      const _exhaustive: never = provider;
      throw new Error(`unknown EMBED_PROVIDER: ${_exhaustive}`);
    }
  }
  return cached;
}

/**
 * Override the cached embedding adapter. Tests use this to inject a
 * deterministic stub so we don't hit a real Workers AI / Vertex endpoint.
 */
export function setEmbeddingAdapterForTest(impl: EmbeddingAdapter | null): void {
  cached = impl;
}

export type { EmbeddingAdapter, EmbeddingTaskType } from './interface.ts';
