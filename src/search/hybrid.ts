// Hybrid Search — FTS (Postgres tsvector) + Vector (pgvector cosine).
// Results merged via Reciprocal-Rank-Fusion (k=60). RLS handles visibility.
//
// Post-RRF: Group-by-Parent (PLAN-document-linking §10.5 D5). Sub-Doc-Hits
// (is_subdoc=true) werden unter ihren Parent-Hit als `child_hits[]` gruppiert
// wenn der Parent auch im Hit-Set ist. Sonst bleibt Sub-Doc top-level mit
// `linked_parent`-Field für Navigation.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { objectRefs, objects } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { embeddingAdapter } from '../adapters/embed/index.ts';
import { kms } from '../adapters/kms/index.ts';
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

/**
 * LinkedParent — when a sub-doc hit's parent is NOT in the top-K set, we
 * surface the parent inline so the agent can navigate up.
 *
 * PLAN-document-linking §10.5 D5.
 */
export interface LinkedParent {
  id: string;
  uri: string;
  title: string | null;
  summary: string | null;
}

export interface HybridSearchHit {
  id: string;
  subtype: string | null;
  title: string | null;
  /**
   * KC2 stores the user-provided description; we expose it as `summary`
   * for caller ergonomics (matches RefView convention).
   */
  summary?: string | null;
  uri?: string;
  score: number;
  /**
   * Group-by-Parent (D5): sub-doc-hits unter dem Parent. Cap=2 child_hits
   * (token-Budget). Wenn mehr Children matchen, suchen die nach RRF-Score
   * den höchstrangigen 2 aus.
   */
  childHits?: ReadonlyArray<HybridSearchHit>;
  /**
   * Group-by-Parent (D5): sub-doc-Hit dessen Parent NICHT im Top-K war.
   * Sub-doc bleibt top-level, Parent wird inline durchgereicht für
   * Navigation.
   */
  linkedParent?: LinkedParent;
  // SEC-K-027: ftsRank + vectorScore wurden früher mit-emittiert. Das ist ein
  // Triangulation-Side-Channel: ein Angreifer mit Write-Surface kann
  // Object-Erstellung + Score-Drift korrelieren um Existenz/Content privater
  // Rows zu inferieren. Felder bleiben für Debug-Mode optional in der Type-
  // Definition, werden aber im Default-Response nicht mehr gesetzt.
  ftsRank?: number | undefined;
  vectorScore?: number | undefined;
}

const MAX_CHILD_HITS_PER_PARENT = 2;
const objectUri = (id: string): string => `kc://object/${id}`;

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
  // SEC-K-024: Query MUSS denselben Per-User-Salt-Postfix kriegen wie die
  // Index-Embeddings (composeEmbedSource). Sonst wären die Vektor-Geometrien
  // verschoben und ein Match wäre zufallsbasiert. Wenn Salt-Resolve fail
  // → continue ohne (besser degraded als komplett kaputt; FTS-branch greift).
  const embedSaltHex = await kms()
    .resolveEmbedSalt(ctx.userId, ctx.requestId)
    .catch(() => null);
  const saltedQuery = embedSaltHex ? `${queryForEmbed} §${embedSaltHex}` : queryForEmbed;
  const queryEmbed = embeddingAdapter()
    .embed([saltedQuery], 'RETRIEVAL_QUERY')
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
    // Fetch limit*2 pre-group hits — Group-by-Parent kann bis zur Hälfte
    // collapsen, das ergibt nach Gruppierung wieder ~limit top-level Hits.
    const preGroupLimit = Math.min(limit * 2, 50);
    const fused = rrfFuse([ftsHits, vectorHits], 60, preGroupLimit);

    // Re-hydrate metadata + isSubdoc + summary from objects-table for all
    // pre-group fused IDs in one batched query. INNER JOIN through RLS for
    // visibility.
    const fusedIds = fused.map((f) => f.id);
    type MetaRow = {
      id: string;
      subtype: string | null;
      title: string | null;
      description: string | null;
      isSubdoc: boolean;
    };
    const metaRows: MetaRow[] =
      fusedIds.length === 0
        ? []
        : await db
            .select({
              id: objects.id,
              subtype: objects.subtype,
              title: objects.title,
              description: objects.description,
              isSubdoc: objects.isSubdoc,
            })
            .from(objects)
            .where(inArray(objects.id, fusedIds));

    const metaById = new Map<string, MetaRow>();
    for (const m of metaRows) metaById.set(m.id, m);

    // SEC-K-027: ftsRank + vectorScore werden nicht mehr emittiert
    // (Triangulation-Side-Channel-Schutz).
    const fusedHits: HybridSearchHit[] = fused.flatMap((f) => {
      const meta = metaById.get(f.id);
      if (!meta) return []; // RLS-filtered or deleted post-search
      return [
        {
          id: f.id,
          subtype: meta.subtype,
          title: meta.title,
          summary: meta.description,
          uri: objectUri(f.id),
          score: f.score,
        },
      ];
    });

    return groupByParent(db, fusedHits, limit);
  });
}

/**
 * Group-by-Parent post-processing (PLAN-document-linking §10.5 D5).
 *
 *   1. Identify sub-doc hits (is_subdoc=true in objects table).
 *   2. Batch-fetch parents-of-subdocs via object_refs(role='resource').
 *   3. For each sub-doc hit:
 *      - If parent is in the top-level hit-set → attach as child_hits,
 *        suppress sub-doc from top-level. Parent inherits sub-doc's score
 *        if higher (max).
 *      - Else → keep sub-doc top-level + populate `linked_parent` for
 *        navigation. Parent's title/summary lookup batched.
 *
 *   Final top-level result trimmed to `limit`. Within child_hits cap at
 *   MAX_CHILD_HITS_PER_PARENT per parent.
 */
async function groupByParent(
  db: Parameters<Parameters<typeof withUserTx>[2]>[0],
  preHits: HybridSearchHit[],
  limit: number,
): Promise<HybridSearchHit[]> {
  if (preHits.length === 0) return [];

  // Identify sub-doc hits — we need their is_subdoc flag, which we already
  // have in the metaById map but isn't carried in HybridSearchHit. Re-fetch
  // is_subdoc + parent-resolution in batches.
  const allIds = preHits.map((h) => h.id);
  const subdocRows = await db
    .select({ id: objects.id, isSubdoc: objects.isSubdoc })
    .from(objects)
    .where(inArray(objects.id, allIds));
  const isSubdocById = new Map<string, boolean>();
  for (const r of subdocRows) isSubdocById.set(r.id, r.isSubdoc);

  const subdocIds = preHits.filter((h) => isSubdocById.get(h.id) === true).map((h) => h.id);
  if (subdocIds.length === 0) {
    return preHits.slice(0, limit);
  }

  // Batch: parents-of-subdocs (role='resource', joined on objects for
  // title/summary lookup). Returns rows where to_id ∈ subdocIds.
  const parentRows = await db
    .select({
      toId: objectRefs.toId,
      parentId: objectRefs.fromId,
      parentTitle: objects.title,
      parentDescription: objects.description,
    })
    .from(objectRefs)
    .innerJoin(objects, eq(objects.id, objectRefs.fromId))
    .where(and(inArray(objectRefs.toId, subdocIds), eq(objectRefs.role, 'resource')));

  // Multiple parents per subdoc possible — pick the first (highest insertion
  // order; could be improved with score-driven pick, but parents are usually
  // singletons in skill→doc graphs).
  const firstParentBySub = new Map<string, { id: string; title: string | null; description: string | null }>();
  for (const r of parentRows) {
    if (!firstParentBySub.has(r.toId)) {
      firstParentBySub.set(r.toId, { id: r.parentId, title: r.parentTitle, description: r.parentDescription });
    }
  }

  // Build hit-id set for "is parent in top-level".
  const hitIds = new Set(preHits.map((h) => h.id));

  // Walk preHits in original order. Sub-docs whose parent is in hitIds get
  // attached. Others stay top-level (with linkedParent).
  const childrenByParent = new Map<string, HybridSearchHit[]>();
  const topLevel: HybridSearchHit[] = [];
  for (const h of preHits) {
    const isSubdoc = isSubdocById.get(h.id) === true;
    if (!isSubdoc) {
      topLevel.push(h);
      continue;
    }
    const parent = firstParentBySub.get(h.id);
    if (!parent) {
      // orphan subdoc — no resource-ref-parent. Keep top-level.
      topLevel.push(h);
      continue;
    }
    if (hitIds.has(parent.id)) {
      // parent also matched → attach as child
      const list = childrenByParent.get(parent.id) ?? [];
      if (list.length < MAX_CHILD_HITS_PER_PARENT) list.push(h);
      childrenByParent.set(parent.id, list);
    } else {
      // parent not in result set → keep subdoc top-level + linkedParent
      topLevel.push({
        ...h,
        linkedParent: {
          id: parent.id,
          uri: objectUri(parent.id),
          title: parent.title,
          summary: parent.description,
        },
      });
    }
  }

  // Attach child_hits to their parents in topLevel.
  for (let i = 0; i < topLevel.length; i++) {
    const parent = topLevel[i]!;
    const kids = childrenByParent.get(parent.id);
    if (kids && kids.length > 0) {
      // Parent score: max(self, top-child-score) — pulls parents up if a
      // single resource is very relevant but the manifest title isn't.
      const topChildScore = kids[0]!.score;
      topLevel[i] = {
        ...parent,
        score: Math.max(parent.score, topChildScore),
        childHits: kids,
      };
    }
  }

  // Re-sort by score (some parents got bumped) and trim to limit.
  topLevel.sort((a, b) => b.score - a.score);
  return topLevel.slice(0, limit);
}
