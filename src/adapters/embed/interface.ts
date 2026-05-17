// Embedding adapter — generates dense vectors from input text.
//
// Providers (selected via env.EMBED_PROVIDER):
//   - 'cloudflare' (default): Cloudflare Workers AI, @cf/baai/bge-m3, 1024-dim,
//     multilingual. Optional Cloudflare AI Gateway in front (audit/cache/rl).
//   - 'vertex' (legacy): Google Vertex AI text-multilingual-embedding-002,
//     768-dim. Kept for parity/migration; DB schema is sized for 1024.

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbeddingAdapter {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]>;
}
