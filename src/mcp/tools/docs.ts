// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// docs.* — 7 Tools über subtype='doc'. Dateien (Markdown, Code, PDFs,
// Bilder); ID-/Filename-basiert. Body kann binary sein → base64-encoded
// im Input (analog objects.create).
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md §2.1
//
// Approval2-Pendant (vor Migration): apps/server/src/tools/docs-tools.ts.
// Wire-Source-of-Truth-Schemas: apps/server/src/tools/types.ts (`DocsPutInput`,
// `DocsGetInput`, ...). 1:1 portiert, body als base64 (`body_b64`) statt
// union(string|Uint8Array) — der KC2-Pfad nimmt Uint8Array, der approval2-
// Adapter base64-kodiert sowieso intern, also ist `body_b64` der natuerliche
// Wire-Schema-Punkt für Binary-Support (PDFs, Images).
//
// description (= summary) ist plaintext in KC2 (F-22: encryption von description
// wurde in Mig 0003 dropped — sensitive Inhalte gehoeren in body). Daher
// docs.update_summary == updateObject({description, reEmbed: true}).
//
// docs.usages: incoming refs mit role='resource' (KC2-Konvention; entspricht
// approval2's logischem 'skill_resource'-Slot — der storage-Layer kennt nur
// 'resource'/'references'/'depends_on' als KNOWN_ROLES).

import { z } from 'zod';

import {
  createObject,
  listObjects,
  readObject,
  softDeleteObject,
  updateObject,
} from '../../storage/objects.ts';
import { addRef, listIncomingRefs } from '../../storage/refs.ts';
import {
  assertEmbedQuota,
  assertObjectQuota,
  releaseObjectQuota,
} from '../../quota/check.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest } from '../../lib/errors.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

const SUBTYPE_DOC = 'doc';
const ROLE_RESOURCE = 'resource';

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function decodeB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// ─── Zod schemas (mirror approval2/apps/server/src/tools/types.ts) ────────────

const TagsArray = z.array(z.string().min(1).max(64)).max(32).optional();

const DocsPutInput = z
  .object({
    id: z.string().min(1).max(128).optional(),
    filename: z.string().min(1).max(256),
    body_b64: z.string().min(0).max(11_000_000), // ~8 MB raw, base64-inflated
    summary: z.string().min(1).max(2000).optional(),
    mime_type: z.string().min(1).max(128).optional(),
    namespace: z.string().min(1).max(64).optional(),
    category: z.string().min(1).max(64).optional(),
    tags: TagsArray,
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();

const DocsGetInput = z
  .object({
    id: z.string().min(1).max(128),
    expand_body: z.boolean().optional(),
  })
  .strict();

const DocsListInput = z
  .object({
    namespace: z.string().min(1).max(64).optional(),
    category: z.string().min(1).max(64).optional(),
    tags: TagsArray,
    mime_type: z.string().min(1).max(128).optional(),
    embedded_only: z.boolean().optional(),
    without_embedding: z.boolean().optional(),
    sort: z.enum(['updated_at_desc', 'updated_at_asc', 'created_at_desc']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const DocsDeleteInput = z
  .object({
    id: z.string().min(1).max(128),
    force: z.boolean().optional(),
  })
  .strict();

const DocsUsagesInput = z.object({ id: z.string().min(1).max(128) }).strict();

const DocsAttachToInput = z
  .object({
    doc_id: z.string().min(1).max(128),
    skill_ids: z.array(z.string().min(1).max(128)).min(1).max(32),
  })
  .strict();

const DocsUpdateSummaryInput = z
  .object({
    id: z.string().min(1).max(128),
    summary: z.string().min(0).max(2000),
    re_embed: z.boolean().optional(),
  })
  .strict();

// ─── Helper: buildDocMeta — namespace/category in meta_json ─────────────────

function buildDocMeta(input: {
  namespace?: string | undefined;
  category?: string | undefined;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (input.namespace !== undefined) meta['namespace'] = input.namespace;
  if (input.category !== undefined) meta['category'] = input.category;
  return meta;
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerDocsTools(): void {
  // docs.put — write (create or update)
  registerTool({
    name: 'docs.put',
    description:
      'Create or update a markdown/text/binary document. If id is provided, upserts via update; otherwise creates new. Body is base64-encoded (binary-safe).',
    inputSchema: zodToJsonSchema(DocsPutInput),
    annotations: {
      title: 'Create/Update document',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Create/Update document: {{filename}}',
      },
    },
    handler: async (args) => {
      const input = DocsPutInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const body = decodeB64(input.body_b64);

      // Update path (id provided)
      if (input.id !== undefined) {
        const patch: Parameters<typeof updateObject>[1] = {
          title: input.filename,
          body,
        };
        if (input.summary !== undefined) patch.description = input.summary;
        if (input.tags !== undefined) patch.keywords = [...input.tags];
        if (input.expected_version !== undefined) {
          patch.expectedVersion = input.expected_version;
        }
        const meta = buildDocMeta(input);
        if (Object.keys(meta).length > 0) patch.meta = meta;
        try {
          const view = await updateObject(input.id, patch);
          await emitAudit({ action: 'docs.put', resourceId: view.id, result: 'success' });
          return jsonResult(view);
        } catch (e) {
          await emitAudit({ action: 'docs.put', resourceId: input.id, result: 'error' });
          throw e;
        }
      }

      // Create path
      await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: body.byteLength });
      try {
        const createArgs: Parameters<typeof createObject>[0] = {
          subtype: SUBTYPE_DOC,
          title: input.filename,
          filename: input.filename,
          body,
        };
        if (input.summary !== undefined) createArgs.description = input.summary;
        if (input.tags !== undefined) createArgs.keywords = [...input.tags];
        if (input.mime_type !== undefined) createArgs.mimeType = input.mime_type;
        const meta = buildDocMeta(input);
        if (Object.keys(meta).length > 0) createArgs.meta = meta;
        const view = await createObject(createArgs);
        await emitAudit({ action: 'docs.put', resourceId: view.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await releaseObjectQuota(ctx.userId, ctx.requestId, body.byteLength);
        await emitAudit({ action: 'docs.put', result: 'error' });
        throw e;
      }
    },
  });

  // docs.get — read
  registerTool({
    name: 'docs.get',
    description: 'Fetch a single document by id. Pass expand_body=true to receive the body (base64).',
    inputSchema: zodToJsonSchema(DocsGetInput),
    annotations: {
      title: 'Get document',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Read document {{id}}' },
    },
    handler: async (args) => {
      const input = DocsGetInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const r = await readObject(input.id, { includeBody: input.expand_body ?? false });
      const payload: Record<string, unknown> = { ...r.view };
      if (r.body !== undefined) {
        payload['body_b64'] = Buffer.from(r.body).toString('base64');
      }
      return jsonResult(payload);
    },
  });

  // docs.list — read
  registerTool({
    name: 'docs.list',
    description:
      "List the current user's documents (subtype='doc'). Supports paging via limit/cursor and filter by namespace/category/tags/mime_type. Use `embedded_only`/`without_embedding` to filter by embedding status.",
    inputSchema: zodToJsonSchema(DocsListInput),
    annotations: {
      title: 'List documents',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = DocsListInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const opts: Parameters<typeof listObjects>[0] = { subtype: SUBTYPE_DOC };
      if (input.limit !== undefined) opts.limit = input.limit;
      if (input.cursor !== undefined) opts.cursor = input.cursor;
      const result = await listObjects(opts);

      // Optional client-side filter — meta-fields are not server-indexed.
      // Suboptimal but forward-compatible (matches approval2 docs.list semantics).
      const needsFilter =
        input.namespace !== undefined ||
        input.category !== undefined ||
        input.tags !== undefined ||
        input.mime_type !== undefined ||
        input.embedded_only === true ||
        input.without_embedding === true;
      if (!needsFilter) {
        return jsonResult(result);
      }
      const filtered = result.items.filter((obj) => {
        if (
          input.namespace !== undefined &&
          (obj.meta?.['namespace'] as string | undefined) !== input.namespace
        ) {
          return false;
        }
        if (
          input.category !== undefined &&
          (obj.meta?.['category'] as string | undefined) !== input.category
        ) {
          return false;
        }
        if (input.mime_type !== undefined && obj.mimeType !== input.mime_type) {
          return false;
        }
        if (input.tags !== undefined && input.tags.length > 0) {
          const kw = obj.keywords ?? [];
          if (!input.tags.every((t) => kw.includes(t))) return false;
        }
        // embedded_only / without_embedding: KC2 stores embeddings in
        // object_vectors. We don't have that flag inline on ObjectView —
        // proxy via description presence (a description triggers embed in
        // create/update paths). Matches approval2's heuristic.
        if (input.embedded_only === true && !obj.description) return false;
        if (input.without_embedding === true && obj.description) return false;
        return true;
      });
      return jsonResult({ items: filtered, nextCursor: result.nextCursor });
    },
  });

  // docs.delete — danger (refcount-aware soft-delete)
  registerTool({
    name: 'docs.delete',
    description:
      'Soft-delete a document. If refcount > 0 (still referenced by skills), pass force=true to override.',
    inputSchema: zodToJsonSchema(DocsDeleteInput),
    annotations: {
      title: 'Delete document',
      sensitivity: 'danger',
      destructiveHint: true,
      wysiwys: {
        display_template: 'DELETE document {{id}}{{#force}} (force){{/force}}',
      },
    },
    handler: async (args) => {
      const input = DocsDeleteInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      // force=true: skip refcount-check. Otherwise: read obj, bail if refcount>0.
      // KC2 storage.softDeleteObject does NOT auto-check refcount, so we
      // surface the policy here (matches approval2 docs.delete semantics).
      if (input.force !== true) {
        const { view } = await readObject(input.id, { includeBody: false });
        if (view.refcount > 0) {
          throw errBadRequest(
            `docs.delete: document is still referenced by ${view.refcount} object(s); pass force=true to override`,
            { id: input.id, refcount: view.refcount },
          );
        }
      }
      try {
        await softDeleteObject(input.id);
        await emitAudit({
          action: 'docs.delete',
          resourceId: input.id,
          result: 'success',
          details: { force: input.force === true },
        });
        return jsonResult({ deleted: true, id: input.id });
      } catch (e) {
        await emitAudit({ action: 'docs.delete', resourceId: input.id, result: 'error' });
        throw e;
      }
    },
  });

  // docs.usages — read (incoming refs)
  registerTool({
    name: 'docs.usages',
    description:
      "List incoming references to a document (which objects, typically skills, attach it as a resource). Filters on role='resource'.",
    inputSchema: zodToJsonSchema(DocsUsagesInput),
    annotations: {
      title: 'Document usages',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Get usages of doc {{id}}' },
    },
    handler: async (args) => {
      const input = DocsUsagesInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const all = await listIncomingRefs(input.id);
      // approval2-shape: { incoming: [{subtype, id, title}], outgoing: [] }.
      // KC2 listIncomingRefs doesn't denormalize; we only return role='resource'
      // refs (skill_resource-Slot) and surface from_id as id. Title-Resolution
      // wuerde N+1 queries kosten — wir lassen Title weg und der Caller
      // (approval2) kann sich pro id ein objects.get holen, wenn er Title
      // braucht. Matches the "incoming skill-refs" intent.
      const incoming = all
        .filter((r) => r.role === ROLE_RESOURCE)
        .map((r) => ({ id: r.fromId, role: r.role }));
      return jsonResult({ incoming, outgoing: [] });
    },
  });

  // docs.attach_to — write (batch attach to N skills, ein Approval)
  registerTool({
    name: 'docs.attach_to',
    description:
      'Attach a document as a resource to multiple skills (or other parent objects) in one approval. Idempotent per skill (ON CONFLICT DO NOTHING).',
    inputSchema: zodToJsonSchema(DocsAttachToInput),
    annotations: {
      title: 'Attach document to skills',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Attach doc {{doc_id}} to skills: {{skill_ids}}',
      },
    },
    handler: async (args) => {
      const input = DocsAttachToInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const attached: string[] = [];
      const warnings: string[] = [];
      for (const skillId of input.skill_ids) {
        try {
          const r = await addRef({
            fromId: skillId,
            toId: input.doc_id,
            role: ROLE_RESOURCE,
          });
          attached.push(skillId);
          warnings.push(...r.warnings);
        } catch {
          // Single-skill-fail does not kill the batch.
        }
      }
      await emitAudit({
        action: 'docs.attach_to',
        resourceId: input.doc_id,
        result: 'success',
        details: { attached: attached.length, targets: input.skill_ids.length },
      });
      return jsonResult({ attached, alreadyPresent: [], warnings });
    },
  });

  // docs.update_summary — write (encrypted summary + re-embed)
  // F-22: description is plaintext-only (FTS-indexed) in KC2 — no description_enc.
  // Summary lives in `description`, re-embed triggered via updateObject({reEmbed:true}).
  registerTool({
    name: 'docs.update_summary',
    description:
      'Update the summary of a document (stored in description, FTS-indexed). Triggers server-side re-embed unless re_embed=false.',
    inputSchema: zodToJsonSchema(DocsUpdateSummaryInput),
    annotations: {
      title: 'Update document summary',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Update summary for doc {{id}} ({{summary.length}} chars)',
      },
    },
    handler: async (args) => {
      const input = DocsUpdateSummaryInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const reEmbed = input.re_embed ?? true;
      if (reEmbed) await assertEmbedQuota(ctx.userId, ctx.requestId);
      try {
        const view = await updateObject(input.id, {
          description: input.summary,
          reEmbed,
        });
        await emitAudit({
          action: 'docs.update_summary',
          resourceId: input.id,
          result: 'success',
          details: { summaryLength: input.summary.length, reEmbed },
        });
        return jsonResult(view);
      } catch (e) {
        await emitAudit({
          action: 'docs.update_summary',
          resourceId: input.id,
          result: 'error',
        });
        throw e;
      }
    },
  });
}
