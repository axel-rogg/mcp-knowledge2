// REST routes for /v1/objects/*.

import { Hono } from 'hono';
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
} from '../storage/refs.ts';
import { listRevisions, readRevision } from '../storage/revisions.ts';
import { addTag, listTags, removeTag } from '../storage/tags.ts';
import { assertEmbedQuota, assertObjectQuota, releaseObjectQuota } from '../quota/check.ts';
import { emitAudit } from '../observability/audit.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest } from '../lib/errors.ts';

// Inline-body cap: 256 KB binary ≈ 350 KB base64. Any larger upload MUST go
// through the presigned-upload pipeline (POST /v1/uploads/init) so the
// server is not asked to materialise the entire body in memory from a
// single JSON request. Cap dient als Defense gegen JSON-bomb-style RAM
// exhaustion (F-2 in 2026-05-13 audit). 2026-05-17: 22KB → 350KB.
// Begruendung: Skill-Manifests im Bestand sind teils 18KB, Markdown-
// Tutorials oft 50-100KB. 350KB base64 × 100 concurrent ≈ 35MB Memory —
// shared-cpu-1x mit 512MB hat genuegend Headroom.
const INLINE_BODY_INPUT_MAX_B64 = 350 * 1024;

// subtype is a free-form caller-convention string post-ADR-0004.
// Storage interprets nothing; the regex below is just an
// identifier-shape guard against control characters / injection.
const SUBTYPE_PATTERN = /^[a-z][a-z0-9_:-]{0,31}$/;

const CreateBody = z.object({
  subtype: z.string().min(1).max(32).regex(SUBTYPE_PATTERN).optional(),
  title: z.string().max(2048).optional(),
  description: z.string().max(8192).optional(),
  keywords: z.array(z.string().max(64)).max(64).optional(),
  trigger_hints: z.string().max(4096).optional(),
  meta: z.record(z.unknown()).optional(),
  body_b64: z.string().min(1).max(INLINE_BODY_INPUT_MAX_B64),
  mime_type: z.string().max(256).optional(),
  filename: z.string().max(256).optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  embed: z.boolean().optional(),
});

const UpdateBody = z.object({
  title: z.string().max(2048).nullable().optional(),
  description: z.string().max(8192).nullable().optional(),
  keywords: z.array(z.string().max(64)).max(64).nullable().optional(),
  trigger_hints: z.string().max(4096).nullable().optional(),
  meta: z.record(z.unknown()).nullable().optional(),
  body_b64: z.string().max(INLINE_BODY_INPUT_MAX_B64).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  expires_at: z.number().int().nullable().optional(),
  expected_version: z.number().int().positive().optional(),
  re_embed: z.boolean().optional(),
});

const AddRefBody = z.object({
  to_id: z.string().uuid(),
  role: z.string().min(1).max(64),
  meta: z.record(z.unknown()).optional(),
});

const RemoveRefBody = z.object({
  to_id: z.string().uuid(),
  role: z.string().min(1).max(64),
});

const AddTagBody = z.object({ tag: z.string().min(1).max(128) });

export const objectsRouter = new Hono()
  .post('/objects', async (c) => {
    const body = CreateBody.parse(await c.req.json());
    const ctx = requireContext();
    if (!ctx.userId) throw errBadRequest('user context required');

    const bodyBytes = decodeB64(body.body_b64);
    await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: bodyBytes.byteLength });
    if (body.embed) {
      await assertEmbedQuota(ctx.userId, ctx.requestId);
    }

    try {
      const view = await createObject({
        subtype: body.subtype,
        title: body.title,
        description: body.description,
        keywords: body.keywords,
        triggerHints: body.trigger_hints,
        meta: body.meta,
        body: bodyBytes,
        mimeType: body.mime_type,
        filename: body.filename,
        visibility: body.visibility,
        embed: body.embed,
      });
      await emitAudit({ action: 'object.create', resourceId: view.id, result: 'success' });
      return c.json(view, 201);
    } catch (e) {
      // roll back the quota increment we did optimistically
      await releaseObjectQuota(ctx.userId, ctx.requestId, bodyBytes.byteLength);
      await emitAudit({ action: 'object.create', result: 'error' });
      throw e;
    }
  })
  .get('/objects', async (c) => {
    const subtype = c.req.query('subtype') ?? undefined;
    const subtypePrefix = c.req.query('subtype_prefix') ?? undefined;
    // Mutual-exclusive: the caller picks one filter mode. Allowing both
    // would silently take the precedence we happen to choose here, hiding
    // intent. Fail explicitly.
    if (subtype !== undefined && subtypePrefix !== undefined) {
      throw errBadRequest('subtype and subtype_prefix are mutually exclusive');
    }
    // Shape-validate the prefix the same way we validate `subtype` —
    // identifier-shape, no wildcard characters reach the LIKE clause.
    if (subtypePrefix !== undefined) {
      if (!/^[a-z][a-z0-9_:-]{0,30}$/.test(subtypePrefix)) {
        throw errBadRequest(`invalid subtype_prefix '${subtypePrefix}'`);
      }
    }
    const limit = c.req.query('limit') ? Number.parseInt(c.req.query('limit')!, 10) : undefined;
    const cursor = c.req.query('cursor') ? Number.parseInt(c.req.query('cursor')!, 10) : undefined;
    const out = await listObjects({
      ...(subtype !== undefined ? { subtype } : {}),
      ...(subtypePrefix !== undefined ? { subtypePrefix } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return c.json({ items: out.items, next_cursor: out.nextCursor });
  })
  .get('/objects/:id', async (c) => {
    const id = c.req.param('id');
    const expand = c.req.query('expand')?.split(',') ?? [];
    const includeBody = expand.includes('body');
    // PLAN-document-linking §3.2: refs included by default. Pass
    // `?refs_limit=0` to suppress entirely; `?refs_limit=N` to cap.
    const refsLimitRaw = c.req.query('refs_limit');
    const refsLimit = refsLimitRaw !== undefined ? Number.parseInt(refsLimitRaw, 10) : 5;
    if (!Number.isFinite(refsLimit) || refsLimit < 0 || refsLimit > 50) {
      throw errBadRequest('refs_limit must be between 0 and 50');
    }
    try {
      const r = await readObject(id, { includeBody });
      const refs = refsLimit > 0 ? await listRefsForObject(id, refsLimit) : null;
      await emitAudit({ action: 'object.read', resourceId: id, result: 'success' });
      return c.json({
        ...r.view,
        body_b64: r.body ? Buffer.from(r.body).toString('base64') : undefined,
        ...(refs !== null ? { refs } : {}),
      });
    } catch (e) {
      // F-25: log RLS/ownership denials explicitly so SIEM can see them
      if (e instanceof Error && /not found or not visible|not implemented/i.test(e.message)) {
        await emitAudit({ action: 'object.read', resourceId: id, result: 'denied' });
      }
      throw e;
    }
  })
  .patch('/objects/:id', async (c) => {
    const id = c.req.param('id');
    const body = UpdateBody.parse(await c.req.json());
    const ctx = requireContext();
    if (!ctx.userId) throw errBadRequest('user context required');
    if (body.re_embed) await assertEmbedQuota(ctx.userId, ctx.requestId);

    const input: Parameters<typeof updateObject>[1] = {};
    if (body.title !== undefined) input.title = body.title;
    if (body.description !== undefined) input.description = body.description;
    if (body.keywords !== undefined) input.keywords = body.keywords;
    if (body.trigger_hints !== undefined) input.triggerHints = body.trigger_hints;
    if (body.meta !== undefined) input.meta = body.meta;
    if (body.body_b64) input.body = decodeB64(body.body_b64);
    if (body.pinned !== undefined) input.pinned = body.pinned;
    if (body.archived !== undefined) input.archived = body.archived;
    if (body.expires_at !== undefined) input.expiresAt = body.expires_at;
    if (body.expected_version !== undefined) input.expectedVersion = body.expected_version;
    if (body.re_embed !== undefined) input.reEmbed = body.re_embed;

    try {
      const updated = await updateObject(id, input);
      await emitAudit({ action: 'object.update', resourceId: id, result: 'success' });
      return c.json(updated);
    } catch (e) {
      if (e instanceof Error && /not found or not visible|not implemented/i.test(e.message)) {
        await emitAudit({ action: 'object.update', resourceId: id, result: 'denied' });
      }
      throw e;
    }
  })
  .delete('/objects/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await softDeleteObject(id);
      await emitAudit({ action: 'object.soft_delete', resourceId: id, result: 'success' });
      return c.body(null, 204);
    } catch (e) {
      if (e instanceof Error && /not found or not deletable/i.test(e.message)) {
        await emitAudit({ action: 'object.soft_delete', resourceId: id, result: 'denied' });
      }
      throw e;
    }
  })
  .post('/objects/:id/restore', async (c) => {
    const id = c.req.param('id');
    await restoreObject(id);
    await emitAudit({ action: 'object.restore', resourceId: id, result: 'success' });
    return c.body(null, 204);
  })
  .post('/objects/:id/refs', async (c) => {
    const id = c.req.param('id');
    const b = AddRefBody.parse(await c.req.json());
    // PLAN-doc-linking P5: addRef returns { warnings }. REST emittiert 200
    // mit body wenn Warnings da, 204 wenn alles clean — Backward-compat
    // mit Callers die nur Status checken.
    const { warnings } = await addRef({ fromId: id, toId: b.to_id, role: b.role, meta: b.meta });
    await emitAudit({
      action: 'object.ref_add',
      resourceId: id,
      result: 'success',
      details: { to: b.to_id, role: b.role, warning_count: warnings.length },
    });
    if (warnings.length > 0) return c.json({ warnings }, 200);
    return c.body(null, 204);
  })
  .delete('/objects/:id/refs', async (c) => {
    const id = c.req.param('id');
    const b = RemoveRefBody.parse(await c.req.json());
    await removeRef(id, b.to_id, b.role);
    await emitAudit({ action: 'object.ref_remove', resourceId: id, result: 'success', details: { to: b.to_id, role: b.role } });
    return c.body(null, 204);
  })
  .get('/objects/:id/usages', async (c) => {
    const id = c.req.param('id');
    const [outgoing, incoming] = await Promise.all([
      listOutgoingRefs(id),
      listIncomingRefs(id),
    ]);
    return c.json({ outgoing, incoming });
  })
  .post('/objects/:id/tags', async (c) => {
    const id = c.req.param('id');
    const b = AddTagBody.parse(await c.req.json());
    await addTag(id, b.tag);
    return c.body(null, 204);
  })
  .delete('/objects/:id/tags', async (c) => {
    const id = c.req.param('id');
    const tag = c.req.query('tag');
    if (!tag) throw errBadRequest('?tag= query required');
    await removeTag(id, tag);
    return c.body(null, 204);
  })
  .get('/objects/:id/tags', async (c) => {
    const id = c.req.param('id');
    return c.json({ tags: await listTags(id) });
  })
  // Revisions are populated automatically by updateObject() every time the
  // body changes (currentVersion bumps). They are owner-only — F-6 of the
  // 2026-05-13 audit tightened the RLS policy so a shared user can't read
  // pre-share content.
  .get('/objects/:id/revisions', async (c) => {
    const id = c.req.param('id');
    const items = await listRevisions(id);
    return c.json({ items });
  })
  .get('/objects/:id/revisions/:version', async (c) => {
    const id = c.req.param('id');
    const versionParam = c.req.param('version');
    const version = Number.parseInt(versionParam, 10);
    if (!Number.isInteger(version) || version < 1) {
      throw errBadRequest(`invalid version '${versionParam}'`);
    }
    const r = await readRevision(id, version);
    return c.json({
      object_id: r.objectId,
      version: r.version,
      created_at: r.createdAt,
      body_b64: Buffer.from(r.body).toString('base64'),
    });
  });

function decodeB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
