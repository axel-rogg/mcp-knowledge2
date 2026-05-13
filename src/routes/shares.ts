import { Hono } from 'hono';
import { z } from 'zod';
import {
  createShare,
  listSharedWithMe,
  listSharesForObject,
  revokeShare,
} from '../storage/shares.ts';
import { emitAudit } from '../observability/audit.ts';

const CreateShareBody = z.object({
  granted_to: z.string().uuid(),
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
      resourceKind: share.resourceKind,
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
  });
