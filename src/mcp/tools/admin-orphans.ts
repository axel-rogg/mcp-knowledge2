/**
 * Phase 3b.4 — Admin-Tools für verwaiste Objects.
 *
 *   admin.list_orphan_objects (read, admin-only)
 *   admin.purge_orphan_object (danger, admin-only)  — Decision 10: hard-delete
 *
 * "Orphan" = User-owned Object dessen owner_id auf einen User in status
 * IN ('erased', 'suspended') zeigt. Group-owned Objects können nicht
 * verwaisen (Group-archive ist eigenes Lifecycle).
 *
 * Plan-Ref: docs/plans/active/PLAN-generic-objects-and-group-ownership.md §3b.4
 */

import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';

import { objects, users } from '../../db/schema.ts';
import { withUserTx } from '../../db/client.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest, errForbidden, errNotFound } from '../../lib/errors.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';
import { emitAudit } from '../../observability/audit.ts';

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

const AdminListOrphansInput = z.object({}).strict();

const AdminPurgeOrphanInput = z
  .object({
    object_id: z.string().uuid(),
  })
  .strict();

async function requireAdmin(userId: string, requestId: string): Promise<void> {
  const isAdmin = await withUserTx(userId, requestId, async (db) => {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.role === 'admin';
  });
  if (!isAdmin) throw errForbidden('admin role required');
}

export function registerAdminOrphansTools(): void {
  registerTool({
    name: 'admin.list_orphan_objects',
    description:
      'List objects whose owner is in status "erased" or "suspended" — these objects are orphaned and need admin intervention (adopt or hard-delete). Admin-only. Returns up to 1000 entries per status bucket.',
    inputSchema: zodToJsonSchema(AdminListOrphansInput),
    annotations: {
      title: 'List orphan objects',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      AdminListOrphansInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await requireAdmin(ctx.userId, ctx.requestId);

      const items = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
        const erased = await db
          .select({
            id: objects.id,
            subtype: objects.subtype,
            title: objects.title,
            createdAt: objects.createdAt,
            ownerEmail: users.email,
          })
          .from(objects)
          .leftJoin(users, eq(users.id, objects.ownerId))
          .where(and(isNull(objects.owningGroupId), eq(users.status, 'erased')));
        const suspended = await db
          .select({
            id: objects.id,
            subtype: objects.subtype,
            title: objects.title,
            createdAt: objects.createdAt,
            ownerEmail: users.email,
          })
          .from(objects)
          .leftJoin(users, eq(users.id, objects.ownerId))
          .where(and(isNull(objects.owningGroupId), eq(users.status, 'suspended')));
        return [
          ...erased.slice(0, 1000).map((r) => ({
            id: r.id,
            subtype: r.subtype,
            title: r.title,
            orphanReason: 'erased_owner' as const,
            lastSeenOwnerEmail: r.ownerEmail,
            createdAt: r.createdAt,
          })),
          ...suspended.slice(0, 1000).map((r) => ({
            id: r.id,
            subtype: r.subtype,
            title: r.title,
            orphanReason: 'suspended_owner' as const,
            lastSeenOwnerEmail: r.ownerEmail,
            createdAt: r.createdAt,
          })),
        ];
      });

      return jsonResult({ items });
    },
  });

  registerTool({
    name: 'admin.purge_orphan_object',
    description:
      'Hard-delete an orphaned object (Decision 10: orphans skip the soft-delete ceremony — bodies are already unreachable via the erased/suspended owner). Verifies that the target is genuinely an orphan before purging. Admin-only.',
    inputSchema: zodToJsonSchema(AdminPurgeOrphanInput),
    annotations: {
      title: 'Hard-delete orphan',
      sensitivity: 'danger',
      write: true,
      wysiwys: {
        display_template: 'Hard-delete orphan object {{object_id}}',
      },
    },
    handler: async (args) => {
      const input = AdminPurgeOrphanInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await requireAdmin(ctx.userId, ctx.requestId);

      await withUserTx(ctx.userId, ctx.requestId, async (db) => {
        // Sanity-Check: ist das wirklich ein Orphan?
        const rows = await db
          .select({
            id: objects.id,
            owningGroupId: objects.owningGroupId,
            ownerStatus: users.status,
          })
          .from(objects)
          .leftJoin(users, eq(users.id, objects.ownerId))
          .where(eq(objects.id, input.object_id))
          .limit(1);
        const o = rows[0];
        if (!o) throw errNotFound(`object ${input.object_id} not found`);
        if (o.owningGroupId) {
          throw errBadRequest(
            `object ${o.id} is group-owned — cannot purge as orphan (use groups.archive flow)`,
          );
        }
        if (o.ownerStatus !== 'erased' && o.ownerStatus !== 'suspended') {
          throw errBadRequest(
            `object ${o.id} is not orphan (owner status: ${o.ownerStatus ?? 'unknown'})`,
          );
        }
        // Hard-Delete (Decision 10: kein soft-delete fuer Orphans)
        await db.delete(objects).where(eq(objects.id, input.object_id));
      });

      await emitAudit({
        action: 'admin.purge_orphan',
        resourceId: input.object_id,
        result: 'success',
      });

      return jsonResult({ ok: true, objectId: input.object_id });
    },
  });
}
