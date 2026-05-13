// Hybrid Search — FTS (Postgres tsvector) + Vector (pgvector cosine).
// Results merged via Reciprocal-Rank-Fusion (k=60). RLS handles visibility.

import { sql } from 'drizzle-orm';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { embeddingAdapter } from '../adapters/embed/vertex.ts';
import { rrfFuse } from './rrf.ts';
import { errBadRequest } from '../lib/errors.ts';
import type { ObjectKind } from '../types/domain.ts';

export interface HybridSearchInput {
  query: string;
  kind?: ObjectKind;
  limit?: number;
  ftsLimit?: number;
  vectorLimit?: number;
}

export interface HybridSearchHit {
  id: string;
  kind: ObjectKind;
  subtype: string | null;
  title: string | null;
  score: number;
  ftsRank?: number | undefined;
  vectorScore?: number | undefined;
}

export async function hybridSearch(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const query = input.query.trim();
  if (query.length === 0) throw errBadRequest('empty query');

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const ftsLimit = Math.min(Math.max(input.ftsLimit ?? 50, 1), 200);
  const vectorLimit = Math.min(Math.max(input.vectorLimit ?? 50, 1), 200);

  // Compute the query embedding in parallel with FTS query
  const queryEmbed = embeddingAdapter()
    .embed([query], 'RETRIEVAL_QUERY')
    .then((v) => v[0] ?? null)
    .catch(() => null);

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // ─── FTS ─────────────────────────────────────────────────────────────
    const ftsRows = await db.execute(sql`
      SELECT id, kind, subtype, title,
             ts_rank_cd(search_tsv, websearch_to_tsquery('simple', ${query})) AS rank
      FROM objects
      WHERE search_tsv @@ websearch_to_tsquery('simple', ${query})
        AND deleted_at IS NULL
        AND archived = false
        ${input.kind ? sql`AND kind = ${input.kind}` : sql``}
      ORDER BY rank DESC
      LIMIT ${ftsLimit}
    `);

    type FtsRow = { id: string; kind: ObjectKind; subtype: string | null; title: string | null; rank: number };
    const ftsHits = (ftsRows.rows as FtsRow[]).map((r) => ({ id: r.id, score: r.rank }));

    // ─── Vector ──────────────────────────────────────────────────────────
    const vec = await queryEmbed;
    let vecRows: { id: string; kind: ObjectKind; subtype: string | null; title: string | null; score: number }[] = [];
    if (vec) {
      const vecLiteral = `[${vec.join(',')}]`;
      const result = await db.execute(sql`
        SELECT o.id, o.kind, o.subtype, o.title,
               1 - (v.embedding <=> ${vecLiteral}::vector) AS score
        FROM object_vectors v
        JOIN objects o ON o.id = v.object_id
        WHERE o.deleted_at IS NULL
          AND o.archived = false
          ${input.kind ? sql`AND o.kind = ${input.kind}` : sql``}
        ORDER BY v.embedding <=> ${vecLiteral}::vector
        LIMIT ${vectorLimit}
      `);
      vecRows = result.rows as typeof vecRows;
    }
    const vectorHits = vecRows.map((r) => ({ id: r.id, score: r.score }));

    // ─── RRF Fusion ──────────────────────────────────────────────────────
    const fused = rrfFuse([ftsHits, vectorHits], 60, limit);

    // Re-hydrate metadata from whichever list saw each hit first
    const metaById = new Map<string, { kind: ObjectKind; subtype: string | null; title: string | null }>();
    for (const r of ftsRows.rows as FtsRow[]) {
      metaById.set(r.id, { kind: r.kind, subtype: r.subtype, title: r.title });
    }
    for (const r of vecRows) {
      if (!metaById.has(r.id)) {
        metaById.set(r.id, { kind: r.kind, subtype: r.subtype, title: r.title });
      }
    }

    const ftsScoreById = new Map(ftsHits.map((h) => [h.id, h.score]));
    const vecScoreById = new Map(vectorHits.map((h) => [h.id, h.score]));

    return fused.map((f) => {
      const meta = metaById.get(f.id) ?? { kind: 'doc' as ObjectKind, subtype: null, title: null };
      return {
        id: f.id,
        kind: meta.kind,
        subtype: meta.subtype,
        title: meta.title,
        score: f.score,
        ftsRank: ftsScoreById.get(f.id),
        vectorScore: vecScoreById.get(f.id),
      };
    });
  });
}
