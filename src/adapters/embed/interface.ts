// Embedding adapter — generates dense vectors from input text.
// Provider in v2 is Google Vertex AI (text-embedding-005, dim=768).

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbeddingAdapter {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]>;
}
