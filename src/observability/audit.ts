// Audit-event emitter. Writes append-only rows to `audit_log`.
// App role has no UPDATE/DELETE on audit_log (see migrations/0001_rls.sql).

import { auditLog } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { nowMs } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';
import type { AuditEventInput } from '../types/domain.ts';

export async function emitAudit(event: AuditEventInput): Promise<void> {
  try {
    const ctx = requireContext();
    if (!ctx.userId) {
      // service-only flows record under a sentinel actor; we use the null UUID
      // to make it distinguishable in queries
      await withUserTx('00000000-0000-0000-0000-000000000000', ctx.requestId, async (db) => {
        await db.insert(auditLog).values({
          ts: nowMs(),
          actorUserId: '00000000-0000-0000-0000-000000000000',
          action: event.action,
          resourceId: event.resourceId ?? null,
          requestId: ctx.requestId,
          result: event.result,
          details: event.details ?? null,
          viaProxy: ctx.viaProxy ?? false,
          approvalId: ctx.approvalId ?? null,
        });
      });
      return;
    }
    await withUserTx(ctx.userId, ctx.requestId, async (db) => {
      await db.insert(auditLog).values({
        ts: nowMs(),
        actorUserId: ctx.userId!,
        action: event.action,
        resourceId: event.resourceId ?? null,
        requestId: ctx.requestId,
        result: event.result,
        details: event.details ?? null,
        viaProxy: ctx.viaProxy ?? false,
        approvalId: ctx.approvalId ?? null,
      });
    });
  } catch (e) {
    // never let audit failures take down the request — but log loudly
    logger.error({ err: e, event }, 'audit emit failed');
  }
}
