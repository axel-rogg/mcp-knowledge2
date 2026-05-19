// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// notes.* — 5 Tools über subtype='note'. Free-form Markdown-Notes.
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md §2.5
//
// Approval2-Pendant (vor Migration): apps/server/src/tools/notes-tools.ts.
// Body ist plain UTF-8 (≤16 KB), kein base64 (anders als objects.create) —
// dieser Schema-Punkt matched approval2's hardcoded Wrapper, damit der
// Auto-Forwarder den Schema-Drift nicht detektiert.

import { z } from 'zod';

import { listObjects, readObject, softDeleteObject } from '../../storage/objects.ts';
import { createObject, updateObject } from '../../storage/objects.ts';
import { assertEmbedQuota, assertObjectQuota, releaseObjectQuota } from '../../quota/check.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest } from '../../lib/errors.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

const SUBTYPE_NOTE = 'note';

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}


// ─── Zod schemas (mirror approval2/apps/server/src/tools/types.ts) ────────────

const CreateInput = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(16_384),
    description: z.string().min(1).max(2000).optional(),
    embed: z.boolean().optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();

const UpdateInput = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(16_384).optional(),
    // approval2-Compat: null = "description clearen"; KC2's UpdateObjectInput
    // akzeptiert string | null. Schema-Refine zaehlt null als defined-Patch.
    description: z.string().max(2000).nullable().optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.description !== undefined ||
      v.keywords !== undefined,
    { message: 'at least one of title/body/description/keywords must be provided' },
  );

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const GetInput = z.object({ id: z.string().min(1).max(128) }).strict();
const DeleteInput = z.object({ id: z.string().min(1).max(128) }).strict();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerNotesTools(): void {
  registerTool({
    name: 'notes.create',
    description:
      'Create a Markdown note with title + body. Optional summary (`description`) — if embed=true, KC2 indexes it for semantic search.',
    inputSchema: zodToJsonSchema(CreateInput),
    annotations: {
      title: 'Create note',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Create note: {{title}} — {{body|preview:120}}',
      },
    },
    handler: async (args) => {
      const input = CreateInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const body = utf8(input.body);
      await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: body.byteLength });
      if (input.embed) await assertEmbedQuota(ctx.userId, ctx.requestId);
      try {
        const view = await createObject({
          subtype: SUBTYPE_NOTE,
          title: input.title,
          body,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.keywords !== undefined ? { keywords: [...input.keywords] } : {}),
          ...(input.embed !== undefined ? { embed: input.embed } : {}),
        });
        await emitAudit({ action: 'notes.create', resourceId: view.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await releaseObjectQuota(ctx.userId, ctx.requestId, body.byteLength);
        await emitAudit({ action: 'notes.create', result: 'error' });
        throw e;
      }
    },
  });

  registerTool({
    name: 'notes.update',
    description:
      'Update a note (partial-replace of provided fields). At least one of title/body/description/keywords required.',
    inputSchema: zodToJsonSchema(UpdateInput),
    annotations: {
      title: 'Update note',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Update note {{id}} — title:{{title|preview:60}} body:{{body|preview:120}}',
      },
    },
    handler: async (args) => {
      const input = UpdateInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const patch: Parameters<typeof updateObject>[1] = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = utf8(input.body);
      if (input.description !== undefined) patch.description = input.description;
      if (input.keywords !== undefined) patch.keywords = [...input.keywords];
      if (input.expected_version !== undefined) patch.expectedVersion = input.expected_version;
      try {
        const view = await updateObject(input.id, patch);
        await emitAudit({ action: 'notes.update', resourceId: view.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await emitAudit({ action: 'notes.update', resourceId: input.id, result: 'error' });
        throw e;
      }
    },
  });

  registerTool({
    name: 'notes.list',
    description:
      "List the current user's notes (subtype='note'). Supports paging via limit/cursor (updated_at-based).",
    inputSchema: zodToJsonSchema(ListInput),
    annotations: {
      title: 'List notes',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = ListInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const opts: Parameters<typeof listObjects>[0] = { subtype: SUBTYPE_NOTE };
      if (input.limit !== undefined) opts.limit = input.limit;
      if (input.cursor !== undefined) opts.cursor = input.cursor;
      const result = await listObjects(opts);
      return jsonResult(result);
    },
  });

  registerTool({
    name: 'notes.get',
    description: 'Fetch a single note by id (body is returned as plain UTF-8 string).',
    inputSchema: zodToJsonSchema(GetInput),
    annotations: {
      title: 'Get note',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = GetInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const { view, body } = await readObject(input.id, { includeBody: true });
      // body is Uint8Array → decode to plain text for the note-Surface.
      const payload = {
        ...view,
        body: body !== undefined ? fromUtf8(body) : undefined,
      };
      return jsonResult(payload);
    },
  });

  registerTool({
    name: 'notes.delete',
    description: 'Soft-delete a note by id (refcount-checked; archived for 30d before hard-delete).',
    inputSchema: zodToJsonSchema(DeleteInput),
    annotations: {
      title: 'Delete note',
      sensitivity: 'danger',
      destructiveHint: true,
      wysiwys: { display_template: 'DELETE note {{id}}' },
    },
    handler: async (args) => {
      const input = DeleteInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        await softDeleteObject(input.id);
        await emitAudit({ action: 'notes.delete', resourceId: input.id, result: 'success' });
        return jsonResult({ deleted: true, id: input.id });
      } catch (e) {
        await emitAudit({ action: 'notes.delete', resourceId: input.id, result: 'error' });
        throw e;
      }
    },
  });
}
