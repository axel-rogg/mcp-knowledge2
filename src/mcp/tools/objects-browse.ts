// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// objects.browse_* — high-level Browser-Wrapper auf listObjects/readObject.
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md §2.8
//
// Hintergrund Naming-Konflikt: KC2 hat bereits `objects.list` und
// `objects.read` als Low-Level-Tools (siehe register_tools.ts). Diese
// werden separat mit `annotations.tags: ['low-level']` getaggt, sodass der
// approval2-Auto-Forwarder sie ausblendet. Damit wir auf KC2-Seite keine
// Duplicate-Registration produzieren, heißen die High-Level-Variants
// hier `objects.browse_list` und `objects.browse_read`.
//
// Tool-Inventar:
//   - objects.browse_list (read) — body-frei, Tabellen-Listing für PWA-Tab
//   - objects.browse_read (read) — full object + body-preview (truncated UTF-8)
//
// Body-Truncation-Strategie:
//   `truncateForBrowser(body, maxChars)` dekodiert die Uint8Array als UTF-8
//   (mit `fatal: false` damit binary nicht crasht) und schneidet auf
//   maxChars Code-Points. Binary-Bodies oder bodies wo UTF-8-Decoding zu
//   einer langen Replacement-Char-Kette degeneriert: optional body_b64
//   für die ersten N Bytes — die UI kann dann zwischen Text- und
//   Binary-Preview entscheiden. PWA-Storage-Tab nutzt aktuell Text.
//
// Approval2-Pendant: apps/server/src/tools/objects-tools.ts. Schemas sind
// 1:1 portiert (ObjectsListInput, ObjectsReadInput).

import { z } from 'zod';

import { listObjects, readObject } from '../../storage/objects.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest } from '../../lib/errors.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

const DEFAULT_BODY_PREVIEW_CHARS = 2000;

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * Decode the first `maxChars` UTF-8 code-points of a binary body for
 * browser-display. fatal=false leaves replacement characters in the output
 * instead of throwing on binary bodies — the caller can switch to b64-preview
 * via `objects.read` if the result looks degenerate (PWA shows a "binary"
 * banner when too many replacement chars appear).
 */
function truncateForBrowser(body: Uint8Array, maxChars = DEFAULT_BODY_PREVIEW_CHARS): {
  text: string;
  truncated: boolean;
  originalBytes: number;
} {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(body);
  if (decoded.length <= maxChars) {
    return { text: decoded, truncated: false, originalBytes: body.byteLength };
  }
  // Slice on code-point boundary (string.slice is by UTF-16 code-unit;
  // good enough for the preview-surface since PWA renders code-units anyway).
  return {
    text: decoded.slice(0, maxChars),
    truncated: true,
    originalBytes: body.byteLength,
  };
}

// ─── Zod-Schemas (1:1 aus approval2/apps/server/src/tools/types.ts) ─────────

// Free-form subtype guard (mirrors register_tools.ts SUBTYPE regex but
// scoped local — KC2 storage ignores it, this is a shape-guard against
// injection chars).
const SUBTYPE = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_:-]*$/);

const ObjectsBrowseListInput = z
  .object({
    subtype: SUBTYPE.optional(),
    subtype_prefix: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z][a-z0-9_:-]{0,30}$/)
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const ObjectsBrowseReadInput = z
  .object({
    id: z.string().uuid(),
    expand_body: z.boolean().optional(),
    preview_chars: z.number().int().min(1).max(50_000).optional(),
  })
  .strict();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerObjectsBrowseTools(): void {
  registerTool({
    name: 'objects.browse_list',
    description:
      "Browser-friendly list of the current user's objects (no body, metadata only). Optional subtype filter (exact-match via `subtype` OR prefix-match via `subtype_prefix`, e.g. 'app:' for all apps). The two filters are mutually exclusive. Paginated via limit/cursor (updated_at-based).",
    inputSchema: zodToJsonSchema(ObjectsBrowseListInput),
    annotations: {
      title: 'Browse objects',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: {
        display_template:
          'Browse {{#subtype}}{{subtype}} {{/subtype}}{{#subtype_prefix}}{{subtype_prefix}}* {{/subtype_prefix}}objects',
      },
    },
    handler: async (args) => {
      const input = ObjectsBrowseListInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      if (input.subtype !== undefined && input.subtype_prefix !== undefined) {
        throw errBadRequest('subtype and subtype_prefix are mutually exclusive');
      }
      const opts: Parameters<typeof listObjects>[0] = {};
      if (input.subtype !== undefined) opts.subtype = input.subtype;
      if (input.subtype_prefix !== undefined) opts.subtypePrefix = input.subtype_prefix;
      if (input.limit !== undefined) opts.limit = input.limit;
      if (input.cursor !== undefined) opts.cursor = input.cursor;
      const out = await listObjects(opts);
      return jsonResult({ items: out.items, next_cursor: out.nextCursor });
    },
  });

  registerTool({
    name: 'objects.browse_read',
    description:
      'Browser-friendly read of a single object. Returns metadata plus a UTF-8 body preview (default 2000 chars; tune via `preview_chars`, max 50 000). Pass `expand_body=true` to also include the full body as base64 (subject to KC2 1 MB include-body limit). For binary objects the UTF-8 preview may contain replacement characters — UI should switch to b64 in that case.',
    inputSchema: zodToJsonSchema(ObjectsBrowseReadInput),
    annotations: {
      title: 'Browse object',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Browse object {{id}}' },
    },
    handler: async (args) => {
      const input = ObjectsBrowseReadInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      const previewChars = input.preview_chars ?? DEFAULT_BODY_PREVIEW_CHARS;
      // For preview we always need the body; for expand_body=true we also
      // emit it as b64.
      const r = await readObject(input.id, { includeBody: true });
      const body = r.body;
      const payload: Record<string, unknown> = { ...r.view };
      if (body !== undefined) {
        const preview = truncateForBrowser(body, previewChars);
        payload.body_preview = preview.text;
        payload.body_preview_truncated = preview.truncated;
        payload.body_size = preview.originalBytes;
        if (input.expand_body) {
          payload.body_b64 = Buffer.from(body).toString('base64');
        }
      }
      await emitAudit({
        action: 'objects.browse_read',
        resourceId: input.id,
        result: 'success',
      });
      return jsonResult(payload);
    },
  });
}
