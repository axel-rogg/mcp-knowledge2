// Hybrid Search — FTS (Postgres tsvector) + Vector (pgvector cosine).
// Results merged via Reciprocal-Rank-Fusion (k=60). RLS handles visibility.

import { sql } from 'drizzle-orm';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { embeddingAdapter } from '../adapters/embed/index.ts';
import { rrfFuse } from './rrf.ts';
import { errBadRequest } from '../lib/errors.ts';

export interface HybridSearchInput {
  query: string;
  subtypes?: string[];
  /**
   * Prefix-match filters analog to `subtypes` exact-match. e.g. `['app:']`
   * matches all subtypes starting with `app:`. May be combined with
   * `subtypes` — the resulting WHERE-clause is `(subtype IN (...) OR
   * subtype LIKE 'p1%' OR subtype LIKE 'p2%')`, so "all skills AND all
   * apps" is a single search.
   */
  subtypePrefixes?: string[];
  limit?: number;
  ftsLimit?: number;
  vectorLimit?: number;
}

export interface HybridSearchHit {
  id: string;
  subtype: string | null;
  title: string | null;
  score: number;
  // SEC-K-027: ftsRank + vectorScore wurden früher mit-emittiert. Das ist ein
  // Triangulation-Side-Channel: ein Angreifer mit Write-Surface kann
  // Object-Erstellung + Score-Drift korrelieren um Existenz/Content privater
  // Rows zu inferieren. Felder bleiben für Debug-Mode optional in der Type-
  // Definition, werden aber im Default-Response nicht mehr gesetzt.
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

  const subtypeFilter = input.subtypes && input.subtypes.length > 0 ? input.subtypes : null;
  const prefixFilter =
    input.subtypePrefixes && input.subtypePrefixes.length > 0 ? input.subtypePrefixes : null;

  // Validate prefix shape — defense-in-depth against `%`/`_` slipping
  // into the LIKE clause. The MCP/REST layer already shape-checks; this
  // is a second wall.
  if (prefixFilter) {
    for (const p of prefixFilter) {
      if (!/^[a-z][a-z0-9_:-]{0,30}$/.test(p)) {
        throw errBadRequest(`invalid subtype_prefix '${p}'`);
      }
    }
  }

  // Build the subtype-filter fragment once. Search semantics allow
  // BOTH exact-IN and prefix-LIKE simultaneously (combined via OR) —
  // unlike list, this is not mutually exclusive. Use cases like "all
  // skills AND all apps" need both lists in one search.
  const subtypeClause = ((): ReturnType<typeof sql> => {
    const branches: ReturnType<typeof sql>[] = [];
    if (subtypeFilter) {
      // sql`...ANY(${jsArray})` expandiert in drizzle/node-pg zu Tuple-
      // Syntax `($3, $4)` — wirft "op ANY/ALL requires array on right side".
      // sql.join produziert `$3, $4` (Komma-separierte Liste), die wir in
      // `subtype IN (...)` packen — semantisch identisch zu `= ANY(array)`.
      const list = sql.join(
        subtypeFilter.map((s) => sql`${s}`),
        sql`, `,
      );
      branches.push(sql`subtype IN (${list})`);
    }
    if (prefixFilter) {
      for (const p of prefixFilter) {
        branches.push(sql`subtype LIKE ${p + '%'}`);
      }
    }
    if (branches.length === 0) return sql``;
    // Join via OR. drizzle's sql.join handles the comma-style; we build
    // an OR-joined fragment manually since `sql.join` defaults to commas.
    let combined = branches[0]!;
    for (let i = 1; i < branches.length; i++) {
      combined = sql`${combined} OR ${branches[i]!}`;
    }
    return sql`AND (${combined})`;
  })();

  // Compute the query embedding in parallel with FTS query.
  //
  // Truncate to a conservative 1500 chars before the embed call. bge-m3
  // accepts ~512 tokens (~2000 chars UTF-8). Vertex multilingual accepts
  // more but the truncation is still a net win — long queries lose
  // semantic focus and waste tokens. The FTS branch above sees the full
  // 2000-char query (cap from src/mcp/register_tools.ts SearchInput), so
  // long queries still benefit from lexical matching.
  const queryForEmbed = query.length > 1500 ? query.slice(0, 1500) : query;
  const queryEmbed = embeddingAdapter()
    .embed([queryForEmbed], 'RETRIEVAL_QUERY')
    .then((v) => v[0] ?? null)
    .catch(() => null);

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // ─── FTS ─────────────────────────────────────────────────────────────
    const ftsRows = await db.execute(sql`
      SELECT id, subtype, title,
             ts_rank_cd(search_tsv, websearch_to_tsquery('simple', ${query})) AS rank
      FROM objects
      WHERE search_tsv @@ websearch_to_tsquery('simple', ${query})
        AND deleted_at IS NULL
        AND archived = false
        ${subtypeClause}
      ORDER BY rank DESC
      LIMIT ${ftsLimit}
    `);

    type FtsRow = { id: string; subtype: string | null; title: string | null; rank: number };
    const ftsHits = (ftsRows.rows as FtsRow[]).map((r) => ({ id: r.id, score: r.rank }));

    // ─── Vector ──────────────────────────────────────────────────────────
    const vec = await queryEmbed;
    let vecRows: { id: string; subtype: string | null; title: string | null; score: number }[] = [];
    if (vec) {
      const vecLiteral = `[${vec.join(',')}]`;
      // Same OR-joined subtype-clause but prefixed against `o.` alias.
      const vecSubtypeClause = ((): ReturnType<typeof sql> => {
        const branches: ReturnType<typeof sql>[] = [];
        if (subtypeFilter) {
          // Siehe FTS-Branch — sql`...ANY(${arr})` expandiert zu Tuple-Syntax.
          // sql.join + IN ist die saubere drizzle-Variante.
          const list = sql.join(
            subtypeFilter.map((s) => sql`${s}`),
            sql`, `,
          );
          branches.push(sql`o.subtype IN (${list})`);
        }
        if (prefixFilter) {
          for (const p of prefixFilter) {
            branches.push(sql`o.subtype LIKE ${p + '%'}`);
          }
        }
        if (branches.length === 0) return sql``;
        let combined = branches[0]!;
        for (let i = 1; i < branches.length; i++) {
          combined = sql`${combined} OR ${branches[i]!}`;
        }
        return sql`AND (${combined})`;
      })();

      const result = await db.execute(sql`
        SELECT o.id, o.subtype, o.title,
               1 - (v.embedding <=> ${vecLiteral}::vector) AS score
        FROM object_vectors v
        JOIN objects o ON o.id = v.object_id
        WHERE o.deleted_at IS NULL
          AND o.archived = false
          ${vecSubtypeClause}
        ORDER BY v.embedding <=> ${vecLiteral}::vector
        LIMIT ${vectorLimit}
      `);
      vecRows = result.rows as typeof vecRows;
    }
    const vectorHits = vecRows.map((r) => ({ id: r.id, score: r.score }));

    // ─── RRF Fusion ──────────────────────────────────────────────────────
    const fused = rrfFuse([ftsHits, vectorHits], 60, limit);

    // Re-hydrate metadata from whichever list saw each hit first
    const metaById = new Map<string, { subtype: string | null; title: string | null }>();
    for (const r of ftsRows.rows as FtsRow[]) {
      metaById.set(r.id, { subtype: r.subtype, title: r.title });
    }
    for (const r of vecRows) {
      if (!metaById.has(r.id)) {
        metaById.set(r.id, { subtype: r.subtype, title: r.title });
      }
    }

    const ftsScoreById = new Map(ftsHits.map((h) => [h.id, h.score]));
    const vecScoreById = new Map(vectorHits.map((h) => [h.id, h.score]));

    // SEC-K-027: ftsRank + vectorScore werden nicht mehr emittiert
    // (Triangulation-Side-Channel-Schutz). Debug-Mode-Flag könnte sie
    // später re-enablen wenn benötigt — heute kein Use-Case.
    void ftsScoreById;
    void vecScoreById;
    return fused.map((f) => {
      const meta = metaById.get(f.id) ?? { subtype: null, title: null };
      return {
        id: f.id,
        subtype: meta.subtype,
        title: meta.title,
        score: f.score,
      };
    });
  });
}
