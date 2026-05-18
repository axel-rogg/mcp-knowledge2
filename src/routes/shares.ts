import { Hono } from 'hono';
import { z } from 'zod';
import {
  createShare,
  createShareWithGroup,
  listSharedWithMe,
  listSharesForGroup,
  listSharesForObject,
  revokeShare,
} from '../storage/shares.ts';
import { emitAudit } from '../observability/audit.ts';

const CreateShareBody = z.object({
  granted_to: z.string().uuid(),
  scope: z.enum(['read', 'write']),
  expires_at: z.number().int().nullable().optional(),
});

// Phase 2-3 Group-Share-Body (write seit Mig 0024 enabled)
const CreateShareWithGroupBody = z.object({
  group_id: z.string().uuid(),
  scope: z.enum(['read', 'write']),
  expires_at: z.number().int().nullable().optional(),
});

export const sharesRouter = new Hono()
  .post('/objects/:id/shares', async (c) => {
    const resourceId = c.req.param('id');
    const b = CreateShareBody.parse(await c.req.json());
    const share = await createShare({
      resourceId,
      grantedTo: b.granted_to,
      scope: b.scope,
      expiresAt: b.expires_at ?? null,
    });
    await emitAudit({
      action: 'share.grant',
      resourceId,
      result: 'success',
      details: { granted_to: b.granted_to, scope: b.scope },
    });
    return c.json(share, 201);
  })
  .get('/objects/:id/shares', async (c) => {
    const resourceId = c.req.param('id');
    const shares = await listSharesForObject(resourceId);
    return c.json({ items: shares });
  })
  .delete('/shares/:share_id', async (c) => {
    const shareId = c.req.param('share_id');
    try {
      await revokeShare(shareId);
      await emitAudit({ action: 'share.revoke', resourceId: shareId, result: 'success' });
      return c.body(null, 204);
    } catch (e) {
      if (e instanceof Error && /not found or already revoked/i.test(e.message)) {
        await emitAudit({ action: 'share.revoke', resourceId: shareId, result: 'denied' });
      }
      throw e;
    }
  })
  .get('/shared-with-me', async (c) => {
    const shares = await listSharedWithMe();
    return c.json({ items: shares });
  })

  // P3a: list all active group-grants for a group (Caller muss Member sein,
  // RLS-Policy `grants_self` enforced das. Non-Member → leere Liste).
  .get('/groups/:id/shares', async (c) => {
    const groupId = c.req.param('id');
    const shares = await listSharesForGroup(groupId);
    return c.json({ items: shares });
  })

  // ─── Phase 1: Share with Group (Item 6c) ─────────────────────────────
  .post('/objects/:id/share-with-group', async (c) => {
    const resourceId = c.req.param('id');
    const b = CreateShareWithGroupBody.parse(await c.req.json());
    const share = await createShareWithGroup({
      resourceId,
      groupId: b.group_id,
      scope: b.scope,
      expiresAt: b.expires_at ?? null,
    });
    await emitAudit({
      action: 'share.granted_to_group',
      resourceId,
      result: 'success',
      details: {
        group_id: b.group_id,
        scope: b.scope,
        via_cascade_from_object_id: share.viaCascadeFromObjectId,
      },
    });
    return c.json(share, 201);
  });
