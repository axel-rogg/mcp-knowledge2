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
import { addRef, listIncomingRefs, listOutgoingRefs, removeRef } from '../storage/refs.ts';
import { addTag, listTags, removeTag } from '../storage/tags.ts';
import { assertEmbedQuota, assertObjectQuota, releaseObjectQuota } from '../quota/check.ts';
import { emitAudit } from '../observability/audit.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest } from '../lib/errors.ts';

const KIND = z.enum(['doc', 'skill', 'app', 'memo']);

const CreateBody = z.object({
  kind: KIND,
  subtype: z.string().max(64).optional(),
  title: z.string().max(2048).optional(),
  description: z.string().max(8192).optional(),
  keywords: z.array(z.string().max(64)).max(64).optional(),
  trigger_hints: z.string().max(4096).optional(),
  meta: z.record(z.unknown()).optional(),
  body_b64: z.string().min(1),
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
  body_b64: z.string().optional(),
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
        kind: body.kind,
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
      await emitAudit({ action: 'object.create', resourceKind: body.kind, resourceId: view.id, result: 'success' });
      return c.json(view, 201);
    } catch (e) {
      // roll back the quota increment we did optimistically
      await releaseObjectQuota(ctx.userId, ctx.requestId, bodyBytes.byteLength);
      await emitAudit({ action: 'object.create', resourceKind: body.kind, result: 'error' });
      throw e;
    }
  })
  .get('/objects', async (c) => {
    const kind = c.req.query('kind') as z.infer<typeof KIND> | undefined;
    const subtype = c.req.query('subtype') ?? undefined;
    const limit = c.req.query('limit') ? Number.parseInt(c.req.query('limit')!, 10) : undefined;
    const cursor = c.req.query('cursor') ? Number.parseInt(c.req.query('cursor')!, 10) : undefined;
    const out = await listObjects({
      kind: kind && KIND.options.includes(kind) ? kind : undefined,
      subtype,
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return c.json({ items: out.items, next_cursor: out.nextCursor });
  })
  .get('/objects/:id', async (c) => {
    const id = c.req.param('id');
    const includeBody = c.req.query('expand')?.split(',').includes('body') ?? false;
    const r = await readObject(id, { includeBody });
    await emitAudit({ action: 'object.read', resourceKind: r.view.kind, resourceId: id, result: 'success' });
    return c.json({
      ...r.view,
      body_b64: r.body ? Buffer.from(r.body).toString('base64') : undefined,
    });
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

    const updated = await updateObject(id, input);
    await emitAudit({ action: 'object.update', resourceId: id, result: 'success' });
    return c.json(updated);
  })
  .delete('/objects/:id', async (c) => {
    const id = c.req.param('id');
    await softDeleteObject(id);
    await emitAudit({ action: 'object.soft_delete', resourceId: id, result: 'success' });
    return c.body(null, 204);
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
    await addRef({ fromId: id, toId: b.to_id, role: b.role, meta: b.meta });
    await emitAudit({ action: 'object.ref_add', resourceId: id, result: 'success', details: { to: b.to_id, role: b.role } });
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
  });

function decodeB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
