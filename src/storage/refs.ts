// Knowledge-graph refs between objects. RLS on object_refs delegates to
// both endpoints' objects visibility (see migrations/0001_rls.sql + 0017).

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { objectRefs, objects, shareGrants } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { createShareWithGroup, revokeCascadeSharesFrom } from './shares.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest, errNotFound } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';

/**
 * Roles die einen Bundle-Cascade triggern wenn parent ein Skill ist.
 * Phase 1: nur 'resource' (Skill → Doc). Phase 2+ koennte 'recipe_ingredient'
 * etc. ergaenzen — `BUNDLE_PARENT_SUBTYPES` muss dann analog erweitert
 * werden.
 *
 * PLAN-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §7
 */
const BUNDLE_ROLES = ['resource'] as const;
const BUNDLE_PARENT_SUBTYPES = ['skill_manifest'] as const;

/**
 * Closed vocabulary of ref-roles (PLAN-document-linking §10.5 D4).
 *
 * Unknown roles in the database (from older data) are accepted but treated
 * as 'references' (soft-default) by consumers.
 */
export const KNOWN_ROLES = ['resource', 'references', 'depends_on'] as const;
export type KnownRole = (typeof KNOWN_ROLES)[number];

/**
 * RefView is the shape returned to MCP-tool callers — denormalised with
 * target/source title + summary + URI so the agent can decide whether to
 * follow up without an extra round-trip.
 *
 * PLAN-Ref: PLAN-document-linking §3.2.
 */
export interface RefView {
  role: string;
  id: string;
  subtype: string | null;
  title: string | null;
  summary: string | null;
  uri: string;
}

export interface RefsForObject {
  outgoing: RefView[];
  incoming: RefView[];
  truncated: { outgoing: boolean; incoming: boolean };
}

/**
 * PLAN-document-linking §9 P9: eager-embed mode for refs.
 *
 * Caller passes `roles` (e.g. `['resource']`) — for matching outgoing refs
 * the body is fetched and base64-encoded inline. Cap-Strategie:
 *   - per-ref MAX_BYTES_PER_REF = 1 MB (= readObject's INCLUDE_BODY_MAX_BYTES)
 *   - summed budget DEFAULT_BUDGET_BYTES = 200 KB across all expanded bodies
 *   - body_size pre-checked via batched objects-query, no R2/decrypt-waste
 *
 * Body-Expansion-Marker:
 *   - body, bodyEncoding='base64' → eager-loaded
 *   - truncatedReason='oversized' → ref skipped (single ref > 1 MB)
 *   - truncatedReason='budget'    → ref skipped (cumulative > budget)
 */
export interface ExpandedRefView extends RefView {
  body?: string;
  bodyEncoding?: 'base64';
  truncatedReason?: 'oversized' | 'budget';
}

const DEFAULT_REFS_LIMIT = 5;
const MAX_REFS_LIMIT = 50;

function objectUri(id: string): string {
  return `kc://object/${id}`;
}

export interface AddRefInput {
  fromId: string;
  toId: string;
  role: string;
  meta?: Record<string, unknown> | null;
}

/** Maximum graph depth searched for a cycle when adding a new ref. */
const CYCLE_DETECTION_DEPTH = 32;

export interface AddRefResult {
  /**
   * Soft-validation warnings (PLAN-document-linking §10.5 R/P5).
   * Caller propagates these to the MCP-tool-response so the agent can
   * see them. The ref is still added — warnings are advisory.
   */
  warnings: string[];
}

export async function addRef(input: AddRefInput): Promise<AddRefResult> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  if (input.fromId === input.toId) {
    throw errBadRequest('self-ref not allowed (from_id === to_id)');
  }

  const warnings: string[] = [];
  // Cascade-Targets aus der TX rauspropagiert — TX-COMMIT erst, dann
  // Cascade in separater TX (Cross-TX siehe PLAN §7).
  const cascadeTargets: Array<{ groupId: string; scope: 'read' | 'write' }> = [];
  let cascadeChildId: string | null = null;
  let cascadeParentId: string | null = null;

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // verify both ends visible under RLS, plus pull target description for
    // soft-summary-validation (PLAN-doc-linking §3.4 + P5).
    // Phase 1 sharing: zusätzlich subtype + cascade_on_share laden für
    // BUNDLE_ROLES-Filter (Item 7 Cascade-Hook).
    const visible = await db
      .select({
        id: objects.id,
        description: objects.description,
        subtype: objects.subtype,
        cascadeOnShare: objects.cascadeOnShare,
      })
      .from(objects)
      .where(or(eq(objects.id, input.fromId), eq(objects.id, input.toId)));
    if (visible.length < 2) {
      throw errNotFound('one or both objects not found or not visible');
    }
    const fromRow = visible.find((r) => r.id === input.fromId);

    const toRow = visible.find((r) => r.id === input.toId);
    if (toRow && (toRow.description === null || toRow.description.trim() === '')) {
      warnings.push(
        `target object ${input.toId} has no description — agent will load defensively when traversing refs. Set description via objects.update for lazy-load to work.`,
      );
    }

    // Cycle detection: would adding (from → to) create a cycle?
    // Reachable if `from` is already reachable from `to` (forward traversal).
    // Bounded BFS up to CYCLE_DETECTION_DEPTH hops — typical knowledge-graphs
    // stay shallow, but this caps the worst-case query cost.
    const seen = new Set<string>([input.toId]);
    let frontier: string[] = [input.toId];
    for (let depth = 0; depth < CYCLE_DETECTION_DEPTH && frontier.length > 0; depth++) {
      const r = await db
        .select({ toId: objectRefs.toId })
        .from(objectRefs)
        .where(inArray(objectRefs.fromId, frontier));
      const next: string[] = [];
      for (const row of r) {
        if (row.toId === input.fromId) {
          throw errBadRequest('ref would create a cycle in the knowledge graph');
        }
        if (!seen.has(row.toId)) {
          seen.add(row.toId);
          next.push(row.toId);
        }
      }
      frontier = next;
    }

    const inserted = await db
      .insert(objectRefs)
      .values({
        fromId: input.fromId,
        toId: input.toId,
        role: input.role,
        metaJson: input.meta ?? null,
        createdAt: nowMs(),
      })
      .onConflictDoNothing()
      .returning({ fromId: objectRefs.fromId });

    if (inserted.length > 0) {
      // refcount snapshot on `to` — only increment if a new row was inserted
      await db
        .update(objects)
        .set({ refcount: sql`${objects.refcount} + 1` })
        .where(eq(objects.id, input.toId));

      // is_subdoc toggle (PLAN-document-linking §10.5 D2): idempotent set-to-
      // true for role='resource'. EXISTS-check on remove ensures M:N safety
      // (multiple skills may point at the same doc).
      if (input.role === 'resource') {
        await db
          .update(objects)
          .set({ isSubdoc: true })
          .where(eq(objects.id, input.toId));
      }

      // ── Phase 1 sharing Cascade-Hook (Item 7) ──────────────────────
      // 3-fach-Check: role IN BUNDLE_ROLES + parent.subtype IS 'skill_
      // manifest' + parent.cascade_on_share=TRUE. Sammelt aktive
      // Group-Shares des Parents; eigentliche createShareWithGroup-
      // Calls passieren NACH dem TX-COMMIT (Cross-TX, akzeptiert für
      // Phase 1 — bei Fail bleibt der Ref aber kein Cascade-Share, idempotent
      // retry via repeat-addRef).
      if (
        (BUNDLE_ROLES as readonly string[]).includes(input.role) &&
        fromRow &&
        (BUNDLE_PARENT_SUBTYPES as readonly string[]).includes(fromRow.subtype ?? '') &&
        fromRow.cascadeOnShare === true
      ) {
        const activeShares = await db
          .select({
            groupId: shareGrants.grantedToGroupId,
            scope: shareGrants.scope,
          })
          .from(shareGrants)
          .where(
            and(
              eq(shareGrants.resourceId, input.fromId),
              isNull(shareGrants.revokedAt),
            ),
          );
        for (const s of activeShares) {
          if (s.groupId) {
            cascadeTargets.push({ groupId: s.groupId, scope: s.scope as 'read' | 'write' });
          }
        }
        if (cascadeTargets.length > 0) {
          cascadeChildId = input.toId;
          cascadeParentId = input.fromId;
        }
      }
    }
  });

  // Cascade-Phase: NACH TX-COMMIT. Jeder Group-Share triggert eigenen
  // createShareWithGroup-Call (eigene TX, eigener FOR UPDATE auf child-
  // Object für Lazy-Migration). Failures werden geloggt aber re-thrown —
  // partial-cascade ist akzeptabel, retry via repeat-addRef (ON CONFLICT
  // im share_grants-Unique-Index macht es idempotent).
  if (cascadeChildId && cascadeParentId && cascadeTargets.length > 0) {
    for (const target of cascadeTargets) {
      try {
        await createShareWithGroup({
          resourceId: cascadeChildId,
          groupId: target.groupId,
          scope: target.scope as 'read', // Phase 1 Group-Shares sind read-only
          viaCascadeFromObjectId: cascadeParentId,
        });
      } catch (err) {
        logger.warn(
          {
            err,
            parent: cascadeParentId,
            child: cascadeChildId,
            group: target.groupId,
          },
          'cascade share-with-group failed (cross-TX, idempotent retry via repeat-addRef)',
        );
        warnings.push(
          `cascade-share to group ${target.groupId} failed; retry by removing+re-adding the ref`,
        );
      }
    }
  }

  return { warnings };
}

export async function removeRef(fromId: string, toId: string, role: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  let didDelete = false;
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const deleted = await db
      .delete(objectRefs)
      .where(
        and(eq(objectRefs.fromId, fromId), eq(objectRefs.toId, toId), eq(objectRefs.role, role)),
      )
      .returning({ fromId: objectRefs.fromId });
    if (deleted.length > 0) {
      didDelete = true;
      await db
        .update(objects)
        .set({ refcount: sql`GREATEST(${objects.refcount} - 1, 0)` })
        .where(eq(objects.id, toId));

      // is_subdoc M:N-safe toggle: only flip back to false when the LAST
      // resource-ref to `toId` is removed. EXISTS-check uses
      // idx_refs_to_role(to_id, role) from migration 0017.
      if (role === 'resource') {
        const stillAny = await db
          .select({ x: sql<number>`1` })
          .from(objectRefs)
          .where(and(eq(objectRefs.toId, toId), eq(objectRefs.role, 'resource')))
          .limit(1);
        if (stillAny.length === 0) {
          await db
            .update(objects)
            .set({ isSubdoc: false })
            .where(eq(objects.id, toId));
        }
      }
    }
  });

  // ── Phase 1 sharing Cascade-Revoke (Item 7) ─────────────────────────
  // Wenn ein BUNDLE_ROLES-Ref entfernt wurde, revoke alle Cascade-Shares
  // mit via_cascade_from_object_id=parentId. Direkte Shares (without
  // cascade-source) bleiben unangetastet.
  if (didDelete && (BUNDLE_ROLES as readonly string[]).includes(role)) {
    try {
      const n = await revokeCascadeSharesFrom(fromId, toId);
      if (n > 0) {
        logger.info(
          { parent: fromId, child: toId, revoked: n },
          'cascade-shares revoked after removeRef',
        );
      }
    } catch (err) {
      logger.warn(
        { err, parent: fromId, child: toId },
        'cascade-revoke after removeRef failed (cross-TX, manual cleanup possible)',
      );
    }
  }
}

export interface RefRow {
  fromId: string;
  toId: string;
  role: string;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export async function listOutgoingRefs(fromId: string): Promise<RefRow[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db.select().from(objectRefs).where(eq(objectRefs.fromId, fromId));
    return r.map((row) => ({
      fromId: row.fromId,
      toId: row.toId,
      role: row.role,
      meta: row.metaJson as Record<string, unknown> | null,
      createdAt: row.createdAt,
    }));
  });
}

export async function listIncomingRefs(toId: string): Promise<RefRow[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db.select().from(objectRefs).where(eq(objectRefs.toId, toId));
    return r.map((row) => ({
      fromId: row.fromId,
      toId: row.toId,
      role: row.role,
      meta: row.metaJson as Record<string, unknown> | null,
      createdAt: row.createdAt,
    }));
  });
}

/**
 * listRefsForObject — denormalised refs view for embedding into `objects.read`
 * responses. Joins `object_refs` with `objects` so the agent gets target/source
 * title + summary inline (no second round-trip needed).
 *
 * Uses LIMIT n+1 trick — `truncated.X` is boolean, not exact count (PLAN R9).
 * Cap is min(limit, MAX_REFS_LIMIT=50). Both directions fetched in parallel.
 *
 * RLS: object_refs policy (post-migration 0017) requires both endpoints
 * visible. INNER JOIN hides refs to objects the caller can't see — defense
 * against id-leak via shared records.
 *
 * PLAN-Ref: PLAN-document-linking §3.2, §10.5 D1.
 */
export async function listRefsForObject(
  objectId: string,
  limit: number = DEFAULT_REFS_LIMIT,
): Promise<RefsForObject> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  if (limit < 1 || limit > MAX_REFS_LIMIT) {
    throw errBadRequest(`refs_limit must be between 1 and ${MAX_REFS_LIMIT}`);
  }

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const probe = limit + 1; // LIMIT n+1 — truncation is boolean

    // outgoing: from_id = objectId, JOIN target on objects.id = to_id
    const outRows = await db
      .select({
        role: objectRefs.role,
        targetId: objectRefs.toId,
        targetSubtype: objects.subtype,
        targetTitle: objects.title,
        targetDescription: objects.description,
      })
      .from(objectRefs)
      .innerJoin(objects, eq(objects.id, objectRefs.toId))
      .where(and(eq(objectRefs.fromId, objectId), sql`${objects.deletedAt} IS NULL`))
      .orderBy(desc(objectRefs.createdAt))
      .limit(probe);

    // incoming: to_id = objectId, JOIN source on objects.id = from_id
    const inRows = await db
      .select({
        role: objectRefs.role,
        sourceId: objectRefs.fromId,
        sourceSubtype: objects.subtype,
        sourceTitle: objects.title,
        sourceDescription: objects.description,
      })
      .from(objectRefs)
      .innerJoin(objects, eq(objects.id, objectRefs.fromId))
      .where(and(eq(objectRefs.toId, objectId), sql`${objects.deletedAt} IS NULL`))
      .orderBy(desc(objectRefs.createdAt))
      .limit(probe);

    return {
      outgoing: outRows.slice(0, limit).map((r) => ({
        role: r.role,
        id: r.targetId,
        subtype: r.targetSubtype,
        title: r.targetTitle,
        summary: r.targetDescription,
        uri: objectUri(r.targetId),
      })),
      incoming: inRows.slice(0, limit).map((r) => ({
        role: r.role,
        id: r.sourceId,
        subtype: r.sourceSubtype,
        title: r.sourceTitle,
        summary: r.sourceDescription,
        uri: objectUri(r.sourceId),
      })),
      truncated: {
        outgoing: outRows.length > limit,
        incoming: inRows.length > limit,
      },
    };
  });
}

/**
 * expandOutgoingRefBodies — eagerly attach `body` (base64) to outgoing refs
 * whose role is in `roles`. Greedy fill up to `budgetBytes`. Refs over
 * `perRefMaxBytes` skipped with `truncatedReason='oversized'`.
 *
 * Called from `objects.get` handler when `include_bodies` query-param is
 * present. Pre-checks body_size via batched query, then re-uses `readObject`
 * for the actual decrypt-loop.
 */
const DEFAULT_BUDGET_BYTES = 200 * 1024; // 200 KB
const PER_REF_MAX_BYTES = 1024 * 1024; // 1 MB — matches readObject's cap

export async function expandOutgoingRefBodies(
  refs: RefView[],
  roles: ReadonlyArray<string>,
  budgetBytes: number = DEFAULT_BUDGET_BYTES,
): Promise<ExpandedRefView[]> {
  if (refs.length === 0 || roles.length === 0) {
    return refs.map((r) => ({ ...r }) as ExpandedRefView);
  }
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  // batched body_size lookup
  const targetIds = refs.filter((r) => roles.includes(r.role)).map((r) => r.id);
  if (targetIds.length === 0) {
    return refs.map((r) => ({ ...r }) as ExpandedRefView);
  }

  const sizes = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    return await db
      .select({ id: objects.id, bodySize: objects.bodySize })
      .from(objects)
      .where(inArray(objects.id, targetIds));
  });
  const sizeById = new Map(sizes.map((r) => [r.id, r.bodySize]));

  // Import readObject lazily to avoid circular dep with storage/objects.ts.
  const { readObject } = await import('./objects.ts');

  let used = 0;
  const out: ExpandedRefView[] = [];
  for (const ref of refs) {
    if (!roles.includes(ref.role)) {
      out.push({ ...ref });
      continue;
    }
    const size = sizeById.get(ref.id) ?? 0;
    if (size > PER_REF_MAX_BYTES) {
      out.push({ ...ref, truncatedReason: 'oversized' });
      continue;
    }
    if (used + size > budgetBytes) {
      out.push({ ...ref, truncatedReason: 'budget' });
      continue;
    }
    try {
      const r = await readObject(ref.id, { includeBody: true });
      if (r.body !== undefined) {
        out.push({
          ...ref,
          body: Buffer.from(r.body).toString('base64'),
          bodyEncoding: 'base64',
        });
        used += size;
      } else {
        out.push({ ...ref });
      }
    } catch {
      // shared-body-not-implemented, decrypt-fail, etc. → skip silently
      out.push({ ...ref });
    }
  }
  return out;
}

/**
 * listIncomingForBatch — for search hits, batch-fetch up to `limit` incoming
 * refs per id. Returns Map<toId, RefView[]>.
 *
 * Implementation: one parameterised query pulling all matching rows in
 * to_id+created_at order, then JS-partition for top-N per to_id. For the
 * expected scale (top-K=50 hits, limit=2) total rows ≤ ~100 and the JS
 * partition is sub-ms. Avoids window-function SQL + keeps parameterisation
 * via Drizzle's builder.
 *
 * PLAN-Ref: PLAN-document-linking §10.5 R3, §3.2 (Group-by-Parent).
 */
export async function listIncomingForBatch(
  ids: string[],
  limit: number = 2,
): Promise<Map<string, RefView[]>> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  if (ids.length === 0) return new Map();
  if (limit < 1 || limit > MAX_REFS_LIMIT) {
    throw errBadRequest(`limit must be between 1 and ${MAX_REFS_LIMIT}`);
  }

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db
      .select({
        toId: objectRefs.toId,
        fromId: objectRefs.fromId,
        role: objectRefs.role,
        subtype: objects.subtype,
        title: objects.title,
        description: objects.description,
      })
      .from(objectRefs)
      .innerJoin(objects, eq(objects.id, objectRefs.fromId))
      .where(and(inArray(objectRefs.toId, ids), sql`${objects.deletedAt} IS NULL`))
      .orderBy(objectRefs.toId, desc(objectRefs.createdAt));

    const map = new Map<string, RefView[]>();
    for (const row of rows) {
      const list = map.get(row.toId) ?? [];
      if (list.length < limit) {
        list.push({
          role: row.role,
          id: row.fromId,
          subtype: row.subtype,
          title: row.title,
          summary: row.description,
          uri: objectUri(row.fromId),
        });
        map.set(row.toId, list);
      }
    }
    return map;
  });
}
