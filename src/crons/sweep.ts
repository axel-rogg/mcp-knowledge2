// Upload lifecycle cron jobs + orphan-blob cleanup.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { blobDeletionQueue, uploads } from '../db/schema.ts';
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
  // F-8: process the blob_deletion_queue. Items get enqueued by
  // /v1/internal/erase-user (and later by other paths that hard-delete
  // objects). Exponential-ish backoff per attempt, capped at ~24h.
  const now = nowMs();
  const due = await withAdminTx(async (db) => {
    return db
      .select()
      .from(blobDeletionQueue)
      .where(lt(blobDeletionQueue.nextAttemptAt, now))
      .limit(200);
  });
  if (due.length === 0) return;

  let deleted = 0;
  let retried = 0;
  for (const row of due) {
    try {
      await blobStore().delete(row.blobKey);
      await withAdminTx(async (db) => {
        await db.delete(blobDeletionQueue).where(eq(blobDeletionQueue.id, row.id));
      });
      deleted += 1;
    } catch (e) {
      const attempts = row.attempts + 1;
      // Backoff: 5min, 30min, 2h, 8h, 24h, …
      const backoffMs = Math.min(5 * 60 * 1000 * Math.pow(4, attempts - 1), 24 * 60 * 60 * 1000);
      await withAdminTx(async (db) => {
        await db
          .update(blobDeletionQueue)
          .set({
            attempts: sql`${blobDeletionQueue.attempts} + 1`,
            lastError: (e as Error).message.slice(0, 1024),
            nextAttemptAt: now + backoffMs,
          })
          .where(eq(blobDeletionQueue.id, row.id));
      });
      retried += 1;
      logger.warn({ err: e, key: row.blobKey, attempts }, 'blob deletion retry scheduled');
    }
  }
  logger.info({ deleted, retried, total: due.length }, 'blob deletion queue swept');
}
