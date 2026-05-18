// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// memorize.* — 4 Tools über subtype='memo'. Atomare Fakten für semantic recall.
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md
// Approval2-Pendant (vor Migration): apps/server/src/tools/memorize-tools.ts.
//
// Memos sind kurze atomare Fakten (≤ 2000 chars), gespeichert als subtype='memo'.
// `scope` wandert in `meta.scope` (z.B. 'preferences', 'project') — Filter
// laeuft client-side post-fetch (analog approval2-Wrapper). memorize.add MUSS
// `embed: true` setzen — Memos sind explizit fuer Vector-Search angelegt.
//
// Time-Decay: memorize.search re-skaliert die hybrid-search-Scores mit
//   score' = score * exp(-(now - created_at) / half_life)
// half_life default 90 Tage. Aelteres Wissen wird damit relativ leiser, ohne
// dass es ganz verschwindet. Half-Life ist via input.half_life_days
// einstellbar (max 365, min 1).

import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import { createObject, listObjects, softDeleteObject } from '../../storage/objects.ts';
import { objects } from '../../db/schema.ts';
import { withUserTx } from '../../db/client.ts';
import { hybridSearch } from '../../search/hybrid.ts';
import { assertEmbedQuota, assertObjectQuota, releaseObjectQuota } from '../../quota/check.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest } from '../../lib/errors.ts';
import { nowMs } from '../../lib/ids.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

const SUBTYPE_MEMO = 'memo';
const DEFAULT_HALF_LIFE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ─── Zod-Schemas (mirror approval2/apps/server/src/tools/types.ts) ───────────

const AddInput = z
  .object({
    text: z.string().min(1).max(2000),
    scope: z.string().min(1).max(128),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();

const SearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    scope: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    /**
     * Half-life in days for the time-decay re-scoring. Default 90.
     * KC2-Local extension over approval2-Wrapper.
     */
    half_life_days: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const ListRecentInput = z
  .object({
    scope: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const DeleteInput = z.object({ id: z.string().min(1).max(128) }).strict();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerMemorizeTools(): void {
  // ── memorize.add ───────────────────────────────────────────────────────────
  registerTool({
    name: 'memorize.add',
    description:
      'Add an atomic memo fact for semantic recall ("what do I know about X"). Always triggers embedding. Scope groups related memos (preferences, project, …).',
    inputSchema: zodToJsonSchema(AddInput),
    annotations: {
      title: 'Memorize',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Memorize ({{scope}}): "{{text}}"',
      },
    },
    handler: async (args) => {
      const input = AddInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const body = utf8(input.text);
      await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: body.byteLength });
      await assertEmbedQuota(ctx.userId, ctx.requestId);
      try {
        const view = await createObject({
          subtype: SUBTYPE_MEMO,
          title: input.text.slice(0, 200),
          body,
          embed: true,
          meta: { scope: input.scope },
          ...(input.keywords !== undefined ? { keywords: [...input.keywords] } : {}),
        });
        await emitAudit({ action: 'memorize.add', resourceId: view.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await releaseObjectQuota(ctx.userId, ctx.requestId, body.byteLength);
        await emitAudit({ action: 'memorize.add', result: 'error' });
        throw e;
      }
    },
  });

  // ── memorize.search ────────────────────────────────────────────────────────
  registerTool({
    name: 'memorize.search',
    description:
      'Semantic recall over memos. Returns time-decayed score hits restricted to subtype=memo. Half-life default 90 days. Scope filter (meta.scope) is post-fetch.',
    inputSchema: zodToJsonSchema(SearchInput),
    annotations: {
      title: 'Search memos',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Recall: "{{query}}"' },
    },
    handler: async (args) => {
      const input = SearchInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await assertEmbedQuota(ctx.userId, ctx.requestId);

      const limit = input.limit ?? 20;
      const halfLifeMs = (input.half_life_days ?? DEFAULT_HALF_LIFE_DAYS) * MS_PER_DAY;

      // 1. Hybrid search restricted to subtype='memo'. Over-fetch by 3x to give
      //    the decay+scope-filter pipeline room to re-rank before the user-
      //    visible limit kicks in.
      const overfetch = Math.min(limit * 3, 50);
      const rawHits = await hybridSearch({
        query: input.query,
        subtypes: [SUBTYPE_MEMO],
        limit: overfetch,
      });

      if (rawHits.length === 0) {
        await emitAudit({
          action: 'memorize.search',
          result: 'success',
          details: { result_count: 0 },
        });
        return jsonResult({ items: [] });
      }

      // 2. Batch-fetch createdAt + meta.scope for every hit-id (RLS-scoped via
      //    withUserTx). HybridSearchHit doesn't carry these fields.
      const hitIds = rawHits.map((h) => h.id);
      const metaRows = await withUserTx(ctx.userId, ctx.requestId, async (db) =>
        db
          .select({
            id: objects.id,
            createdAt: objects.createdAt,
            metaJson: objects.metaJson,
          })
          .from(objects)
          .where(inArray(objects.id, hitIds)),
      );
      const metaById = new Map<string, { createdAt: number; scope: string | undefined }>();
      for (const r of metaRows) {
        const meta = r.metaJson as Record<string, unknown> | null;
        const scope = typeof meta?.['scope'] === 'string' ? (meta['scope'] as string) : undefined;
        metaById.set(r.id, { createdAt: r.createdAt, scope });
      }

      const now = nowMs();
      const scoped = rawHits.flatMap((h) => {
        const m = metaById.get(h.id);
        if (!m) return []; // race: dropped by RLS between hybridSearch & lookup
        if (input.scope !== undefined && m.scope !== input.scope) return [];
        const ageMs = Math.max(0, now - m.createdAt);
        const decay = Math.exp(-ageMs / halfLifeMs);
        return [
          {
            ...h,
            score: h.score * decay,
            createdAt: m.createdAt,
            scope: m.scope,
          },
        ];
      });

      scoped.sort((a, b) => b.score - a.score);
      const items = scoped.slice(0, limit);

      await emitAudit({
        action: 'memorize.search',
        result: 'success',
        details: { result_count: items.length },
      });
      return jsonResult({ items });
    },
  });

  // ── memorize.list_recent ──────────────────────────────────────────────────
  registerTool({
    name: 'memorize.list_recent',
    description:
      'List recent memos in chronological order (most-recent first). Optional client-side filter by scope (meta.scope).',
    inputSchema: zodToJsonSchema(ListRecentInput),
    annotations: {
      title: 'Recent memos',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = ListRecentInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const opts: Parameters<typeof listObjects>[0] = { subtype: SUBTYPE_MEMO };
      if (input.limit !== undefined) opts.limit = input.limit;
      if (input.cursor !== undefined) opts.cursor = input.cursor;
      const list = await listObjects(opts);
      if (input.scope === undefined) return jsonResult(list);
      const target = input.scope;
      const filtered = list.items.filter(
        (obj) => (obj.meta?.['scope'] as string | undefined) === target,
      );
      return jsonResult({ items: filtered, nextCursor: list.nextCursor });
    },
  });

  // ── memorize.delete ───────────────────────────────────────────────────────
  registerTool({
    name: 'memorize.delete',
    description: 'Delete a memo by id (hard-delete semantically — memos are atomic facts).',
    inputSchema: zodToJsonSchema(DeleteInput),
    annotations: {
      title: 'Delete memo',
      sensitivity: 'danger',
      destructiveHint: true,
      wysiwys: { display_template: 'DELETE memo {{id}}' },
    },
    handler: async (args) => {
      const input = DeleteInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        await softDeleteObject(input.id);
        await emitAudit({ action: 'memorize.delete', resourceId: input.id, result: 'success' });
        return jsonResult({ deleted: true, id: input.id });
      } catch (e) {
        await emitAudit({ action: 'memorize.delete', resourceId: input.id, result: 'error' });
        throw e;
      }
    },
  });
}
