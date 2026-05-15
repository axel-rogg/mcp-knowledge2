-- 0010_embedding_dim_1024.sql
--
-- Embedding-Provider-Wechsel: Vertex (text-multilingual-embedding-002, 768-dim)
-- → Cloudflare Workers AI (@cf/baai/bge-m3, 1024-dim).
--
-- Pre-pilot: keine Embeddings persistiert. Sicherheitsdrop-Pattern statt
-- ALTER-COLUMN-TYPE (das schlägt mit pgvector-HNSW-Index fehl).
--
-- Schema-only change. EMBED_PROVIDER env-Var im Code-Layer steuert welcher
-- Adapter Bytes liefert.

DROP INDEX IF EXISTS idx_objects_vec;

ALTER TABLE object_vectors DROP COLUMN IF EXISTS embedding;
ALTER TABLE object_vectors ADD COLUMN embedding vector(1024);

CREATE INDEX IF NOT EXISTS idx_objects_vec
  ON object_vectors
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
