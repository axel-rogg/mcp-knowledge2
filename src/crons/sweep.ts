// Upload lifecycle cron jobs + orphan-blob cleanup.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { blobDeletionQueue, oboJtiSeen, uploads } from '../db/schema.ts';
import { blobStore } from '../adapters/blob/index.ts';
import { nowMs } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';

const PURGE_AFTER_MS = 60 * 60 * 1000; // 1h karenz after expiry

// Hard cap for blob_deletion_queue retries. After 7 days of failed attempts
// (typically attempts=8: 5m, 20m, 80m, 5.3h, 21h, 24h, 24h, 24h) the row
// is given up on and removed from the queue. Prevents the queue from
// growing without bound if the blob backend is permanently unavailable
// or the key has already been deleted out-of-band.
const BLOB_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BLOB_QUEUE_MAX_ATTEMPTS = 8;

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

/**
 * SEC-K-010: räumt obo_jti_seen-Rows ab deren exp_at überschritten ist.
 * Token sind 120s lebendig + 60s grace = 180s im Worst-Case. Reine
 * Replay-Detection braucht das row nicht laenger.
 */
export async function sweepOboJtiSeen(): Promise<void> {
  // exp_at ist in Sekunden (UNIX-time), nowMs() ist Millisekunden — Compare
  // gegen now-Seconds.
  const nowSec = Math.floor(Date.now() / 1000);
  const deleted = await withAdminTx(async (db) => {
    return db
      .delete(oboJtiSeen)
      .where(lt(oboJtiSeen.expAt, nowSec))
      .returning({ jti: oboJtiSeen.jti });
  });
  if (deleted.length > 0) logger.info({ count: deleted.length }, 'obo_jti_seen sweep: expired');
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
  let givenUp = 0;
  for (const row of due) {
    try {
      await blobStore().delete(row.blobKey);
      await withAdminTx(async (db) => {
        await db.delete(blobDeletionQueue).where(eq(blobDeletionQueue.id, row.id));
      });
      deleted += 1;
    } catch (e) {
      const attempts = row.attempts + 1;
      const enqueuedAt = row.enqueuedAt ?? row.nextAttemptAt;
      const ageMs = now - enqueuedAt;

      // Give-up: queue-row exceeded age or attempt cap. Drop it + emit an
      // error-level log so the operator can investigate (the blob may be
      // permanently inaccessible or already deleted out-of-band). Without
      // this gate the queue would grow unbounded under sustained failures.
      if (attempts >= BLOB_QUEUE_MAX_ATTEMPTS || ageMs >= BLOB_QUEUE_MAX_AGE_MS) {
        await withAdminTx(async (db) => {
          await db.delete(blobDeletionQueue).where(eq(blobDeletionQueue.id, row.id));
        });
        givenUp += 1;
        logger.error(
          {
            err: e,
            key: row.blobKey,
            attempts,
            ageMs,
            cap: { attempts: BLOB_QUEUE_MAX_ATTEMPTS, ageMs: BLOB_QUEUE_MAX_AGE_MS },
          },
          'blob deletion queue: giving up after exhausting retries — manual cleanup may be needed',
        );
        continue;
      }

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
  logger.info(
    { deleted, retried, givenUp, total: due.length },
    'blob deletion queue swept',
  );
}
