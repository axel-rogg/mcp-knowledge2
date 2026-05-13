// Internal-only endpoints (Service-Account-Bearer required).
//
// /v1/internal/erase-user — GDPR-erase cascade for a single user. Called by
//                           mcp-approval2 AFTER the crypto-shred (vault key
//                           destroy) so the cipher rows here become moot.
// /v1/internal/health-deep — full dependency check (db+blob+vertex)
// /v1/internal/bulk-embed   — backfill embeddings (Phase 5+)

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { hardDeleteByOwner } from '../storage/objects.ts';
import { shareGrants, idempotencyRecords, uploads } from '../db/schema.ts';
import { blobStore } from '../adapters/blob/s3.ts';
import { emitAudit } from '../observability/audit.ts';
import { errBadRequest } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';

const EraseBody = z.object({
  user_id: z.string().uuid(),
  confirmation_token: z.string().min(16),
});

export const internalRouter = new Hono()
  .post('/internal/erase-user', async (c) => {
    const b = EraseBody.parse(await c.req.json());
    // confirmation_token validation is the responsibility of mcp-approval2;
    // we additionally require it to be non-empty as a sanity check
    if (b.confirmation_token.length < 16) throw errBadRequest('confirmation_token too short');

    const userId = b.user_id;

    // 1. Cascade-delete via BYPASSRLS admin tx
    const result = await withAdminTx(async (db) => {
      const objectsResult = await hardDeleteByOwner(db, userId);
      const sharesDeleted = await db
        .delete(shareGrants)
        .where(eq(shareGrants.grantedTo, userId))
        .returning({ id: shareGrants.id });
      const sharesByMe = await db
        .delete(shareGrants)
        .where(eq(shareGrants.grantedBy, userId))
        .returning({ id: shareGrants.id });
      const idemDeleted = await db
        .delete(idempotencyRecords)
        .where(eq(idempotencyRecords.userId, userId))
        .returning({ idemKey: idempotencyRecords.idemKey });
      const uploadsDeleted = await db
        .delete(uploads)
        .where(eq(uploads.ownerId, userId))
        .returning({ id: uploads.id });

      return {
        objects: objectsResult.rowsDeleted,
        shares: sharesDeleted.length + sharesByMe.length,
        idempotency: idemDeleted.length,
        uploads: uploadsDeleted.length,
        blobsToDelete: objectsResult.blobsToDelete,
      };
    });

    // 2. Best-effort blob cleanup (failures recorded, not retried — pg-boss
    //    cron `blobs.cleanup_orphans` will sweep anything left)
    let blobsDeleted = 0;
    for (const key of result.blobsToDelete) {
      try {
        await blobStore().delete(key);
        blobsDeleted += 1;
      } catch (e) {
        logger.error({ err: e, key }, 'blob delete during erase-user failed');
      }
    }

    await emitAudit({
      action: 'user.erased',
      resourceKind: 'system',
      resourceId: userId,
      result: 'success',
      details: { ...result, blobs_deleted: blobsDeleted, blobs_pending: result.blobsToDelete.length - blobsDeleted },
    });

    return c.json({
      status: 'ok',
      deleted: {
        objects: result.objects,
        shares: result.shares,
        idempotency: result.idempotency,
        uploads: result.uploads,
        blobs_deleted: blobsDeleted,
        blobs_pending: result.blobsToDelete.length - blobsDeleted,
      },
    });
  })
  .post('/internal/health-deep', async (c) => {
    const checks: Record<string, { status: 'ok' | 'error'; detail?: string }> = {};
    try {
      await withAdminTx(async (db) => {
        await db.execute('SELECT 1');
      });
      checks.db_admin = { status: 'ok' };
    } catch (e) {
      checks.db_admin = { status: 'error', detail: (e as Error).message };
    }
    try {
      await blobStore().exists('__health_deep__');
      checks.blob = { status: 'ok' };
    } catch (e) {
      checks.blob = { status: 'error', detail: (e as Error).message };
    }
    const ok = Object.values(checks).every((c) => c.status === 'ok');
    return c.json({ status: ok ? 'ok' : 'degraded', checks }, ok ? 200 : 503);
  });
