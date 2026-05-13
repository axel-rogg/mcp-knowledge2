// Upload lifecycle cron jobs + orphan-blob cleanup.

import { and, eq, inArray, lt } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { uploads } from '../db/schema.ts';
import { blobStore } from '../adapters/blob/s3.ts';
import { nowMs } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';

const PURGE_AFTER_MS = 60 * 60 * 1000; // 1h karenz after expiry

export async function sweepExpiredUploads(): Promise<void> {
  const now = nowMs();
  const updated = await withAdminTx(async (db) => {
    return db
      .update(uploads)
      .set({ status: 'expired' })
      .where(and(eq(uploads.status, 'pending'), lt(uploads.expiresAt, now)))
      .returning({ id: uploads.id });
  });
  if (updated.length > 0) logger.info({ count: updated.length }, 'uploads sweep: expired pending');
}

export async function purgeExpiredUploads(): Promise<void> {
  const cutoff = nowMs() - PURGE_AFTER_MS;
  await withAdminTx(async (db) => {
    const rows = await db
      .select({ id: uploads.id, blobKey: uploads.blobKey })
      .from(uploads)
      .where(and(eq(uploads.status, 'expired'), lt(uploads.expiresAt, cutoff)));
    if (rows.length === 0) return;
    for (const row of rows) {
      try {
        await blobStore().delete(row.blobKey);
      } catch (e) {
        logger.error({ err: e, key: row.blobKey }, 'blob delete during purge failed');
      }
    }
    await db
      .update(uploads)
      .set({ status: 'hard_deleted' })
      .where(inArray(uploads.id, rows.map((r) => r.id)));
    logger.info({ count: rows.length }, 'uploads purge: hard-deleted expired');
  });
}

export async function cleanupOrphanBlobs(): Promise<void> {
  // Phase 5+: walk blob keys, cross-reference with objects/uploads, delete
  // unreferenced. Placeholder for now — listing blobs is provider-specific.
  logger.debug('cleanup_orphan_blobs: noop (phase 5)');
}
