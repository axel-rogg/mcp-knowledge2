// Internal-only endpoints (Service-Account-Bearer required).
//
// /v1/internal/erase-user — GDPR-erase cascade for a single user. Called by
//                           mcp-approval2 AFTER the crypto-shred (vault key
//                           destroy) so the cipher rows here become moot.
// /v1/internal/health-deep — full dependency check (db+blob+vertex)
// /v1/internal/bulk-embed   — backfill embeddings (Phase 5+)

import { Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { hardDeleteByOwner } from '../storage/objects.ts';
import {
  auditLog,
  blobDeletionQueue,
  idempotencyRecords,
  shareGrants,
  uploads,
} from '../db/schema.ts';
import { blobStore } from '../adapters/blob/index.ts';
import { emitAudit } from '../observability/audit.ts';
import { errBadRequest } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';
import { syncFromApproval2 } from '../users/api.ts';
import type { UserSyncInput } from '../users/api.ts';

const EraseBody = z.object({
  user_id: z.string().uuid(),
  confirmation_token: z.string().min(16),
});

const UserSyncBody = z.object({
  user_id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.union([z.string(), z.null()]).optional(),
  status: z.enum(['active', 'suspended', 'erased']),
  external_id: z.string().optional(),
});

export const internalRouter = new Hono()
  .post('/internal/erase-user', async (c) => {
    const b = EraseBody.parse(await c.req.json());
    // confirmation_token validation is the responsibility of mcp-approval2;
    // we additionally require it to be non-empty as a sanity check
    if (b.confirmation_token.length < 16) throw errBadRequest('confirmation_token too short');

    const userId = b.user_id;

    const now = nowMs();
    const SENTINEL = '00000000-0000-0000-0000-000000000000';

    // 1. Cascade-delete via BYPASSRLS admin tx (F-7: also pseudonymises
    //    historical audit_log rows so the GDPR erase is complete).
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

      // F-7: pseudonymise audit_log rows where this user is the actor.
      // We DON'T delete the rows — that would break the append-only
      // promise the compliance story relies on. We replace the actor
      // UUID with the sentinel, and strip any PII-ish keys from
      // details JSON. The admin role can UPDATE audit_log (the
      // append-only GRANT-REVOKE only locks down knowledge_app).
      //
      // Multi-User-Backdoor-Audit (2026-05-17): strip-Liste war
      // incomplete — `granted_to`, `target_user_id`, `shared_with` only,
      // aber `to`, `from_id`, `to_id`, `resource_id` (alle object-ID-
      // shaped Felder) blieben durch. Folge: nach erase-of-A würden
      // andere User in eigenen audit-rows noch A's Object-IDs sehen
      // (DSGVO "no traces"-Verstoß). Extended strip-Liste deckt jetzt
      // alle bekannten user-binding-keys ab.
      const pseudoActor = await db
        .update(auditLog)
        .set({
          actorUserId: SENTINEL,
          details: sql`
            CASE WHEN ${auditLog.details} IS NULL THEN NULL
                 ELSE ${auditLog.details}
                   - 'granted_to' - 'target_user_id' - 'shared_with'
                   - 'to' - 'from_id' - 'to_id' - 'resource_id'
                   - 'email' - 'display_name' - 'invited_email'
            END
          `,
        })
        .where(eq(auditLog.actorUserId, userId))
        .returning({ id: auditLog.id });

      // F-8: queue every blob for deletion BEFORE we tell the caller
      // we're done. The cron will retry. We do an immediate best-effort
      // pass below and remove succeeded keys from the queue right away.
      if (objectsResult.blobsToDelete.length > 0) {
        await db.insert(blobDeletionQueue).values(
          objectsResult.blobsToDelete.map((key) => ({
            blobKey: key,
            reason: 'erase-user',
            enqueuedAt: now,
            nextAttemptAt: now,
          })),
        );
      }

      return {
        objects: objectsResult.rowsDeleted,
        shares: sharesDeleted.length + sharesByMe.length,
        idempotency: idemDeleted.length,
        uploads: uploadsDeleted.length,
        audit_pseudonymised: pseudoActor.length,
        blobsToDelete: objectsResult.blobsToDelete,
      };
    });

    // 2. Best-effort immediate blob cleanup. Any failures stay in the
    //    queue and get retried by the cron job (F-8).
    let blobsDeleted = 0;
    const stillPending: string[] = [];
    for (const key of result.blobsToDelete) {
      try {
        await blobStore().delete(key);
        blobsDeleted += 1;
        // Remove from queue — best-effort, the cron tolerates duplicates.
        await withAdminTx(async (db) => {
          await db.delete(blobDeletionQueue).where(eq(blobDeletionQueue.blobKey, key));
        });
      } catch (e) {
        stillPending.push(key);
        logger.error({ err: e, key }, 'blob delete during erase-user failed; left in queue');
      }
    }

    // F-8: audit result reflects whether anything is still pending.
    await emitAudit({
      action: 'user.erased',
      resourceId: userId,
      result: stillPending.length === 0 ? 'success' : 'error',
      details: {
        objects_deleted: result.objects,
        shares_deleted: result.shares,
        idempotency_deleted: result.idempotency,
        uploads_deleted: result.uploads,
        audit_pseudonymised: result.audit_pseudonymised,
        blobs_deleted: blobsDeleted,
        blobs_pending: stillPending.length,
      },
    });

    return c.json({
      status: stillPending.length === 0 ? 'ok' : 'partial',
      deleted: {
        objects: result.objects,
        shares: result.shares,
        idempotency: result.idempotency,
        uploads: result.uploads,
        audit_pseudonymised: result.audit_pseudonymised,
        blobs_deleted: blobsDeleted,
        blobs_pending: stillPending.length,
      },
    });
  })
  .post('/internal/users/sync', async (c) => {
    // AS-3 §2.2 + A11: approval2 push-syncs user-state to KC2 on
    // create/suspend/erase. Idempotent — returns `unchanged` when the
    // payload matches the current row.
    const body = UserSyncBody.parse(await c.req.json());
    const syncInput: UserSyncInput = {
      approval2UserId: body.user_id,
      email: body.email,
      displayName: body.display_name ?? null,
      status: body.status,
    };
    if (body.external_id !== undefined) {
      (syncInput as { externalId?: string }).externalId = body.external_id;
    }
    const result = await syncFromApproval2(syncInput);
    await emitAudit({
      action: 'user.synced',
      resourceId: result.kcUserId,
      result: 'success',
      details: {
        upstream_status: result.status,
        approval2_user_id: body.user_id,
        email: body.email,
        status: body.status,
      },
    });
    return c.json({ status: result.status, kc_user_id: result.kcUserId });
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
