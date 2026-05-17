// AS-3 K11: MCP tool registry — wraps the REST surface as MCP tools.
//
// Spec: PLAN-as3-autonomous.md §1.4.
//
// Each tool ships an `annotations.wysiwys.display_template` (mustache-style)
// compatible with approval2's Welle-3-pattern so approval2 can render the
// call in its PWA before forwarding it via OBO. Tool execution calls the
// storage layer directly — same context propagation as REST.
//
// Tool naming convention: lowercase, dotted surface (objects.create, etc.)
// matches approval2's expectations for KC-wrappers.

import { z } from 'zod';
import {
  createObject,
  listObjects,
  readObject,
  restoreObject,
  softDeleteObject,
  updateObject,
} from '../storage/objects.ts';
import {
  addRef,
  listIncomingRefs,
  listOutgoingRefs,
  listRefsForObject,
  removeRef,
  type RefView,
  type RefsForObject,
} from '../storage/refs.ts';
import {
  createShare,
  listSharedWithMe,
  listSharesForObject,
  revokeShare,
} from '../storage/shares.ts';
import { finalizeUpload, getUploadStatus, initUpload } from '../storage/uploads.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { assertEmbedQuota, assertObjectQuota, releaseObjectQuota } from '../quota/check.ts';
import { emitAudit } from '../observability/audit.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest } from '../lib/errors.ts';
import { registerTool } from './tools.ts';
import type { CallToolResult } from './types.ts';

// Subtype is free-form caller-convention post-ADR-0004. Storage does not
// enforce the value; the regex below is an identifier-shape guard against
// control characters / injection.
const SUBTYPE = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_:-]*$/);

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Builds a CallToolResult that includes both a JSON text-block AND one
 * resource_link content-block per outgoing ref — MCP-spec-compliant
 * presentation that Claude Desktop / claude.ai render as preview cards.
 *
 * PLAN-Ref: PLAN-document-linking §10.5 D1 (R1).
 */
function objectWithRefsResult(data: { refs?: RefsForObject } & Record<string, unknown>): CallToolResult {
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(data, null, 2) },
  ];
  const outgoing = data.refs?.outgoing ?? [];
  for (const r of outgoing) {
    content.push({
      type: 'resource_link',
      uri: r.uri,
      name: r.title ?? r.id,
      description: r.summary ?? undefined,
      mimeType: 'text/markdown',
      _meta: { role: r.role, subtype: r.subtype ?? undefined },
    } as unknown as CallToolResult['content'][number]);
  }
  return { content, structuredContent: data };
}

function decodeB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

let registered = false;

/**
 * Register all REST-wrapped tools. Idempotent — repeated calls (e.g. from
 * tests) no-op after the first.
 */
export function registerAllTools(): void {
  if (registered) return;
  registered = true;

  // ─── objects.* ───────────────────────────────────────────────────────────

  const CreateInput = z.object({
    subtype: SUBTYPE.optional(),
    title: z.string().max(2048).optional(),
    description: z.string().max(8192).optional(),
    keywords: z.array(z.string().max(64)).max(64).optional(),
    trigger_hints: z.string().max(4096).optional(),
    meta: z.record(z.unknown()).optional(),
    body_b64: z.string().min(1).max(350 * 1024),
    mime_type: z.string().max(256).optional(),
    filename: z.string().max(256).optional(),
    visibility: z.enum(['private', 'shared']).optional(),
    embed: z.boolean().optional(),
  });

  registerTool({
    name: 'objects.create',
    description: 'Create a new object. `subtype` is a free-form caller-convention string (e.g. "doc", "skill_manifest", "memo", "app:composable"). Body is base64-encoded.',
    inputSchema: zodToJsonSchema(CreateInput),
    annotations: {
      title: 'Create object',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template:
          'Create {{subtype}} "{{title}}" ({{#filename}}{{filename}}, {{/filename}}{{body_size_human}})',
      },
    },
    handler: async (args) => {
      const input = CreateInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const body = decodeB64(input.body_b64);
      await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: body.byteLength });
      if (input.embed) await assertEmbedQuota(ctx.userId, ctx.requestId);
      try {
        const view = await createObject({
          ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
          ...(input.trigger_hints !== undefined ? { triggerHints: input.trigger_hints } : {}),
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
          body,
          ...(input.mime_type !== undefined ? { mimeType: input.mime_type } : {}),
          ...(input.filename !== undefined ? { filename: input.filename } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.embed !== undefined ? { embed: input.embed } : {}),
        });
        await emitAudit({
          action: 'object.create',
          resourceId: view.id,
          result: 'success',
        });
        return jsonResult(view);
      } catch (e) {
        await releaseObjectQuota(ctx.userId, ctx.requestId, body.byteLength);
        await emitAudit({ action: 'object.create', result: 'error' });
        throw e;
      }
    },
  });

  const GetInput = z.object({
    id: z.string().uuid(),
    include_body: z.boolean().optional(),
    /**
     * Maximum number of outgoing+incoming refs to include in the response
     * (default 5, max 50, set to 0 to suppress refs entirely).
     */
    refs_limit: z.number().int().min(0).max(50).optional(),
  });
  registerTool({
    name: 'objects.get',
    description:
      'Fetch an object by id. Returns the object plus its outgoing and incoming knowledge-graph refs (up to 5 each by default — set refs_limit=0 to suppress, max 50). ' +
      'Roles: `resource` (linked object is part of this one — load if your task touches it, e.g. skill resource docs), ' +
      '`references` (see-also, load only if query-relevant), ' +
      '`depends_on` (functional prerequisite — load before executing). ' +
      'Use `refs.outgoing[].uri` (kc://object/...) for follow-up `objects.get` calls. ' +
      'include_body=true returns the decrypted body (base64).',
    inputSchema: zodToJsonSchema(GetInput),
    annotations: {
      title: 'Get object',
      sensitivity: 'read',
      write: false,
      wysiwys: { display_template: 'Read object {{id}}' },
    },
    handler: async (args) => {
      const { id, include_body, refs_limit } = GetInput.parse(args);
      const limit = refs_limit ?? 5;
      const r = await readObject(id, { includeBody: include_body ?? false });
      const refs = limit > 0 ? await listRefsForObject(id, limit) : undefined;
      await emitAudit({ action: 'object.read', resourceId: id, result: 'success' });
      return objectWithRefsResult({
        ...r.view,
        body_b64: r.body ? Buffer.from(r.body).toString('base64') : undefined,
        ...(refs !== undefined ? { refs } : {}),
      });
    },
  });

  const ListInput = z.object({
    subtype: SUBTYPE.optional(),
    // Prefix-Match: `subtype_prefix: 'app:'` matched all `app:*` subtypes.
    // Mutually exclusive with `subtype`.
    subtype_prefix: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_:-]{0,30}$/).optional(),
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  });
  registerTool({
    name: 'objects.list',
    description:
      'List objects with pagination. Optional subtype filter (exact-match via `subtype` OR prefix-match via `subtype_prefix`, e.g. "app:" for all apps). The two filters are mutually exclusive.',
    inputSchema: zodToJsonSchema(ListInput),
    annotations: {
      title: 'List objects',
      sensitivity: 'read',
      write: false,
      wysiwys: {
        display_template:
          'List {{#subtype}}{{subtype}} {{/subtype}}{{#subtype_prefix}}{{subtype_prefix}}* {{/subtype_prefix}}objects',
      },
    },
    handler: async (args) => {
      const input = ListInput.parse(args);
      if (input.subtype !== undefined && input.subtype_prefix !== undefined) {
        throw errBadRequest('subtype and subtype_prefix are mutually exclusive');
      }
      const out = await listObjects({
        ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
        ...(input.subtype_prefix !== undefined ? { subtypePrefix: input.subtype_prefix } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      return jsonResult({ items: out.items, next_cursor: out.nextCursor });
    },
  });

  const UpdateInput = z.object({
    id: z.string().uuid(),
    title: z.string().max(2048).nullable().optional(),
    description: z.string().max(8192).nullable().optional(),
    keywords: z.array(z.string().max(64)).max(64).nullable().optional(),
    trigger_hints: z.string().max(4096).nullable().optional(),
    meta: z.record(z.unknown()).nullable().optional(),
    body_b64: z.string().max(350 * 1024).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    expires_at: z.number().int().nullable().optional(),
    expected_version: z.number().int().positive().optional(),
    re_embed: z.boolean().optional(),
  });
  registerTool({
    name: 'objects.update',
    description: 'Update an object. CAS via expected_version recommended.',
    inputSchema: zodToJsonSchema(UpdateInput),
    annotations: {
      title: 'Update object',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Update object {{id}}{{#title}} (title: "{{title}}"){{/title}}',
      },
    },
    handler: async (args) => {
      const input = UpdateInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      if (input.re_embed) await assertEmbedQuota(ctx.userId, ctx.requestId);

      const patch: Parameters<typeof updateObject>[1] = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.keywords !== undefined) patch.keywords = input.keywords;
      if (input.trigger_hints !== undefined) patch.triggerHints = input.trigger_hints;
      if (input.meta !== undefined) patch.meta = input.meta;
      if (input.body_b64) patch.body = decodeB64(input.body_b64);
      if (input.pinned !== undefined) patch.pinned = input.pinned;
      if (input.archived !== undefined) patch.archived = input.archived;
      if (input.expires_at !== undefined) patch.expiresAt = input.expires_at;
      if (input.expected_version !== undefined) patch.expectedVersion = input.expected_version;
      if (input.re_embed !== undefined) patch.reEmbed = input.re_embed;

      const updated = await updateObject(input.id, patch);
      await emitAudit({ action: 'object.update', resourceId: input.id, result: 'success' });
      return jsonResult(updated);
    },
  });

  const DeleteInput = z.object({ id: z.string().uuid() });
  registerTool({
    name: 'objects.delete',
    description: 'Soft-delete an object (idempotent — second call → 404).',
    inputSchema: zodToJsonSchema(DeleteInput),
    annotations: {
      title: 'Delete object',
      sensitivity: 'destructive',
      write: true,
      wysiwys: { display_template: 'Delete object {{id}}' },
    },
    handler: async (args) => {
      const { id } = DeleteInput.parse(args);
      await softDeleteObject(id);
      await emitAudit({ action: 'object.soft_delete', resourceId: id, result: 'success' });
      return jsonResult({ ok: true, id });
    },
  });

  registerTool({
    name: 'objects.restore',
    description: 'Restore a soft-deleted object.',
    inputSchema: zodToJsonSchema(DeleteInput),
    annotations: {
      title: 'Restore object',
      sensitivity: 'write',
      write: true,
      wysiwys: { display_template: 'Restore object {{id}}' },
    },
    handler: async (args) => {
      const { id } = DeleteInput.parse(args);
      await restoreObject(id);
      await emitAudit({ action: 'object.restore', resourceId: id, result: 'success' });
      return jsonResult({ ok: true, id });
    },
  });

  registerTool({
    name: 'objects.usages',
    description: 'List incoming + outgoing knowledge-graph refs for an object.',
    inputSchema: zodToJsonSchema(z.object({ id: z.string().uuid() })),
    annotations: {
      title: 'Object usages',
      sensitivity: 'read',
      write: false,
      wysiwys: { display_template: 'Get usages of {{id}}' },
    },
    handler: async (args) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(args);
      const [outgoing, incoming] = await Promise.all([listOutgoingRefs(id), listIncomingRefs(id)]);
      return jsonResult({ outgoing, incoming });
    },
  });

  const RefInput = z.object({
    from_id: z.string().uuid(),
    to_id: z.string().uuid(),
    role: z.string().min(1).max(64),
    meta: z.record(z.unknown()).optional(),
  });
  registerTool({
    name: 'objects.add_ref',
    description:
      'Add a knowledge-graph ref from one object to another. Roles: ' +
      '`resource` (target is part of source — load with source), `references` ' +
      '(see-also, optional), `depends_on` (functional prerequisite). ' +
      'Returns soft `warnings[]` if target has no description (agent will then ' +
      'load defensively, killing the lazy-load advantage).',
    inputSchema: zodToJsonSchema(RefInput),
    annotations: {
      title: 'Add ref',
      sensitivity: 'write',
      write: true,
      wysiwys: { display_template: 'Add ref {{from_id}} --[{{role}}]→ {{to_id}}' },
    },
    handler: async (args) => {
      const input = RefInput.parse(args);
      const { warnings } = await addRef({
        fromId: input.from_id,
        toId: input.to_id,
        role: input.role,
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      });
      await emitAudit({
        action: 'object.ref_add',
        resourceId: input.from_id,
        result: 'success',
        details: { to: input.to_id, role: input.role, warning_count: warnings.length },
      });
      return jsonResult({ ok: true, warnings });
    },
  });

  const RemoveRefInput = z.object({
    from_id: z.string().uuid(),
    to_id: z.string().uuid(),
    role: z.string().min(1).max(64),
  });
  registerTool({
    name: 'objects.remove_ref',
    description: 'Remove a knowledge-graph ref.',
    inputSchema: zodToJsonSchema(RemoveRefInput),
    annotations: {
      title: 'Remove ref',
      sensitivity: 'destructive',
      write: true,
      wysiwys: { display_template: 'Remove ref {{from_id}} --[{{role}}]→ {{to_id}}' },
    },
    handler: async (args) => {
      const input = RemoveRefInput.parse(args);
      await removeRef(input.from_id, input.to_id, input.role);
      await emitAudit({
        action: 'object.ref_remove',
        resourceId: input.from_id,
        result: 'success',
        details: { to: input.to_id, role: input.role },
      });
      return jsonResult({ ok: true });
    },
  });

  // ─── shares.* ───────────────────────────────────────────────────────────

  const ShareCreateInput = z.object({
    resource_id: z.string().uuid(),
    granted_to: z.string().uuid(),
    scope: z.enum(['read', 'write']),
    expires_at: z.number().int().nullable().optional(),
  });
  registerTool({
    name: 'shares.create',
    description: 'Share an object with another user (read or write scope).',
    inputSchema: zodToJsonSchema(ShareCreateInput),
    annotations: {
      title: 'Create share',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Share {{resource_id}} with user {{granted_to}} ({{scope}})',
      },
    },
    handler: async (args) => {
      const input = ShareCreateInput.parse(args);
      const share = await createShare({
        resourceId: input.resource_id,
        grantedTo: input.granted_to,
        scope: input.scope,
        expiresAt: input.expires_at ?? null,
      });
      await emitAudit({
        action: 'share.grant',
        resourceId: input.resource_id,
        result: 'success',
        details: { granted_to: input.granted_to, scope: input.scope },
      });
      return jsonResult(share);
    },
  });

  registerTool({
    name: 'shares.list',
    description: 'List shares attached to an object.',
    inputSchema: zodToJsonSchema(z.object({ resource_id: z.string().uuid() })),
    annotations: {
      title: 'List shares',
      sensitivity: 'read',
      write: false,
      wysiwys: { display_template: 'List shares for {{resource_id}}' },
    },
    handler: async (args) => {
      const { resource_id } = z.object({ resource_id: z.string().uuid() }).parse(args);
      const items = await listSharesForObject(resource_id);
      return jsonResult({ items });
    },
  });

  registerTool({
    name: 'shares.revoke',
    description: 'Revoke a share by its grant id.',
    inputSchema: zodToJsonSchema(z.object({ share_id: z.string().uuid() })),
    annotations: {
      title: 'Revoke share',
      sensitivity: 'destructive',
      write: true,
      wysiwys: { display_template: 'Revoke share {{share_id}}' },
    },
    handler: async (args) => {
      const { share_id } = z.object({ share_id: z.string().uuid() }).parse(args);
      await revokeShare(share_id);
      await emitAudit({ action: 'share.revoke', resourceId: share_id, result: 'success' });
      return jsonResult({ ok: true });
    },
  });

  registerTool({
    name: 'shares.shared_with_me',
    description: 'List objects that have been shared with the calling user.',
    inputSchema: zodToJsonSchema(z.object({})),
    annotations: {
      title: 'Shared with me',
      sensitivity: 'read',
      write: false,
      wysiwys: { display_template: 'List objects shared with me' },
    },
    handler: async () => {
      const items = await listSharedWithMe();
      return jsonResult({ items });
    },
  });

  // ─── search ─────────────────────────────────────────────────────────────

  const SearchInput = z.object({
    query: z.string().min(1).max(2000),
    subtypes: z.array(SUBTYPE).max(16).optional(),
    // Prefix-match filters analog to `subtypes`. Combinable — see
    // search/hybrid.ts. Caller can request all `app:*` plus exact `skill`
    // in one query.
    subtype_prefixes: z.array(z.string().min(1).max(32).regex(/^[a-z][a-z0-9_:-]{0,30}$/)).max(8).optional(),
    limit: z.number().int().positive().max(50).optional(),
  });
  registerTool({
    name: 'search',
    description:
      "Hybrid search (FTS + pgvector + RRF) over the caller's objects. Filter by `subtypes` (exact-match list) and/or `subtype_prefixes` (prefix-match list, e.g. ['app:'] for all apps). The two filters are combined via OR — combinable, not mutually exclusive.",
    inputSchema: zodToJsonSchema(SearchInput),
    annotations: {
      title: 'Search',
      sensitivity: 'read',
      write: false,
      wysiwys: { display_template: 'Search "{{query}}"' },
    },
    handler: async (args) => {
      const input = SearchInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await assertEmbedQuota(ctx.userId, ctx.requestId);
      const hits = await hybridSearch({
        query: input.query,
        ...(input.subtypes !== undefined ? { subtypes: input.subtypes } : {}),
        ...(input.subtype_prefixes !== undefined ? { subtypePrefixes: input.subtype_prefixes } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      await emitAudit({ action: 'search.hybrid', result: 'success', details: { result_count: hits.length } });
      return jsonResult({ items: hits });
    },
  });

  // ─── uploads.* ──────────────────────────────────────────────────────────

  const UploadInitInput = z.object({
    content_type: z.string().max(256).optional(),
    meta: z.record(z.unknown()).optional(),
  });
  registerTool({
    name: 'uploads.init',
    description: 'Begin a presigned-upload session for bodies > 16 KB.',
    inputSchema: zodToJsonSchema(UploadInitInput),
    annotations: {
      title: 'Upload init',
      sensitivity: 'write',
      write: true,
      wysiwys: { display_template: 'Start upload ({{content_type}})' },
    },
    handler: async (args) => {
      const input = UploadInitInput.parse(args);
      const out = await initUpload({
        ...(input.content_type !== undefined ? { contentType: input.content_type } : {}),
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      });
      await emitAudit({
        action: 'upload.init',
        resourceId: out.uploadId,
        result: 'success',
      });
      return jsonResult({
        upload_id: out.uploadId,
        presigned_url: out.presignedUrl,
        expires_at: out.expiresAt,
      });
    },
  });

  registerTool({
    name: 'uploads.complete',
    description: 'Finalize a presigned upload after the client has PUT the body.',
    inputSchema: zodToJsonSchema(z.object({ upload_id: z.string().uuid() })),
    annotations: {
      title: 'Upload complete',
      sensitivity: 'write',
      write: true,
      wysiwys: { display_template: 'Finalize upload {{upload_id}}' },
    },
    handler: async (args) => {
      const { upload_id } = z.object({ upload_id: z.string().uuid() }).parse(args);
      const status = await finalizeUpload(upload_id);
      await emitAudit({
        action: 'upload.finalize',
        resourceId: upload_id,
        result: 'success',
      });
      return jsonResult(status);
    },
  });

  registerTool({
    name: 'uploads.status',
    description: 'Read the status of an upload session.',
    inputSchema: zodToJsonSchema(z.object({ upload_id: z.string().uuid() })),
    annotations: {
      title: 'Upload status',
      sensitivity: 'read',
      write: false,
      wysiwys: { display_template: 'Get status of upload {{upload_id}}' },
    },
    handler: async (args) => {
      const { upload_id } = z.object({ upload_id: z.string().uuid() }).parse(args);
      return jsonResult(await getUploadStatus(upload_id));
    },
  });
}

// ─── Hand-rolled zod→JSON-Schema (no extra dep) ────────────────────────────
// Drizzle ships with @hono/zod-openapi but that pulls runtime weight. The
// MCP-spec is permissive on the schema shape — minimal JSON-Schema works.
// We avoid `zod-to-json-schema` to keep dependencies tight.

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return walk(schema);
}

function walk(schema: z.ZodTypeAny): Record<string, unknown> {
  // unwrap optional/default/nullable for descend
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return walk((schema._def as { innerType: z.ZodTypeAny }).innerType);
  }
  if (schema instanceof z.ZodNullable) {
    const inner = walk((schema._def as { innerType: z.ZodTypeAny }).innerType);
    const innerType = inner['type'];
    if (typeof innerType === 'string') {
      inner['type'] = [innerType, 'null'];
    }
    return inner;
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema._def.values };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: walk(schema._def.type as z.ZodTypeAny) };
  }
  if (schema instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: walk(schema._def.valueType as z.ZodTypeAny) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = walk(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const out: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) out['required'] = required;
    return out;
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema._def.options.map((o: z.ZodTypeAny) => walk(o)) };
  }
  return {};
}
