/**
 * Phase 3b.3 — Ownership-Routes für Objects.
 *
 * Drei Move-Operations + User-Resolve + Admin-Orphans-List.
 *
 *   POST /v1/objects/:id/move-to-group        body: { group_id }
 *   POST /v1/objects/:id/move-to-personal     body: {}
 *   POST /v1/objects/:id/transfer-ownership   body: { new_owner_id } | { new_owner_email }
 *   GET  /v1/users/resolve?email=…            returns { userId, email, displayName }
 *   GET  /v1/admin/orphans                    admin-only; { items: [...] }
 *
 * Auth: alle inherit `installContext` aus parent (User-Bearer-JWT). RLS in
 * der Storage-Schicht enforct die fachlichen Constraints (caller-is-owner,
 * caller-is-member, etc.).
 *
 * Idempotency-Key wird vom global `idempotency`-Middleware verarbeitet (vgl.
 * server.ts) — keine extra-Logik hier.
 *
 * Plan-Ref: docs/plans/active/PLAN-generic-objects-and-group-ownership.md §3b.3
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  moveObjectToGroup,
  moveObjectToPersonal,
  transferObjectOwnership,
} from '../storage/group-ownership-crypto.ts';
import { withUserTx } from '../db/client.ts';
import { users, objects } from '../db/schema.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest, errForbidden, errNotFound } from '../lib/errors.ts';
import { emitAudit } from '../observability/audit.ts';

const MoveToGroupBody = z.object({
  group_id: z.string().uuid(),
});

const TransferOwnershipBody = z
  .object({
    new_owner_id: z.string().uuid().optional(),
    new_owner_email: z.string().email().optional(),
  })
  .refine((d) => Boolean(d.new_owner_id) !== Boolean(d.new_owner_email), {
    message: 'exactly one of new_owner_id or new_owner_email must be set',
  });

const ResolveQuery = z.object({
  email: z.string().email(),
});

export const objectsOwnershipRouter = new Hono()
  .post('/objects/:id/move-to-group', async (c) => {
    const objectId = c.req.param('id');
    const b = MoveToGroupBody.parse(await c.req.json());
    await moveObjectToGroup({ objectId, groupId: b.group_id });
    await emitAudit({
      action: 'object.move_to_group',
      resourceId: objectId,
      result: 'success',
      details: { group_id: b.group_id },
    });
    return c.json({ ok: true, objectId, owningGroupId: b.group_id });
  })

  .post('/objects/:id/move-to-personal', async (c) => {
    const objectId = c.req.param('id');
    const ctx = requireContext();
    if (!ctx.userId) throw errBadRequest('user context required');
    await moveObjectToPersonal({ objectId });
    await emitAudit({
      action: 'object.move_to_personal',
      resourceId: objectId,
      result: 'success',
      details: { new_owner_id: ctx.userId },
    });
    return c.json({ ok: true, objectId, ownerId: ctx.userId });
  })

  .post('/objects/:id/transfer-ownership', async (c) => {
    const objectId = c.req.param('id');
    const b = TransferOwnershipBody.parse(await c.req.json());

    // Resolve email → user_id wenn email gegeben.
    let newOwnerUserId = b.new_owner_id;
    if (!newOwnerUserId && b.new_owner_email) {
      const resolved = await resolveUserByEmailInternal(b.new_owner_email);
      if (!resolved) {
        throw errNotFound(`user with email ${b.new_owner_email} not registered`);
      }
      newOwnerUserId = resolved.userId;
    }
    if (!newOwnerUserId) {
      throw errBadRequest('new_owner_id or new_owner_email required');
    }

    await transferObjectOwnership({ objectId, newOwnerUserId });
    await emitAudit({
      action: 'object.transfer_ownership',
      resourceId: objectId,
      result: 'success',
      details: { new_owner_id: newOwnerUserId },
    });
    return c.json({ ok: true, objectId, newOwnerId: newOwnerUserId });
  })

  .get('/users/resolve', async (c) => {
    const q = ResolveQuery.parse({
      email: c.req.query('email'),
    });
    const resolved = await resolveUserByEmailInternal(q.email);
    if (!resolved) {
      return c.json({ error: { message: 'user not found' } }, 404);
    }
    return c.json(resolved);
  })

  .get('/admin/orphans', async (c) => {
    const ctx = requireContext();
    if (!ctx.userId) throw errBadRequest('user context required');
    // Admin-Gate: nur admins koennen orphans listen
    const adminCheck = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
      const rows = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, ctx.userId!))
        .limit(1);
      return rows[0]?.role === 'admin';
    });
    if (!adminCheck) throw errForbidden('admin role required');

    // Orphan-Lookup: alle objects mit owner_id != NULL whose owner is in
    // status 'erased' oder 'suspended'. Group-owned objects koennen nicht
    // verwaisen (group-archive ist eigenes Lifecycle).
    const items = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
      // RLS-Policy-Implikation: bei admin-role koennen wir alle objects sehen
      // (siehe RLS-Policy `objects_select` mit admin-Branch). Bei Familie-Mode
      // mit nur 1 user ist die Liste in der Regel leer.
      const rows = await db
        .select({
          id: objects.id,
          subtype: objects.subtype,
          title: objects.title,
          ownerId: objects.ownerId,
          owningGroupId: objects.owningGroupId,
          createdAt: objects.createdAt,
          ownerStatus: users.status,
          ownerEmail: users.email,
        })
        .from(objects)
        .leftJoin(users, eq(users.id, objects.ownerId))
        .where(and(isNull(objects.owningGroupId), eq(users.status, 'erased')));
      // Wir kappen die Resultate konservativ — 1000 reicht fuer Admin-UI.
      const erased = rows.slice(0, 1000);

      const suspendedRows = await db
        .select({
          id: objects.id,
          subtype: objects.subtype,
          title: objects.title,
          ownerId: objects.ownerId,
          owningGroupId: objects.owningGroupId,
          createdAt: objects.createdAt,
          ownerStatus: users.status,
          ownerEmail: users.email,
        })
        .from(objects)
        .leftJoin(users, eq(users.id, objects.ownerId))
        .where(and(isNull(objects.owningGroupId), eq(users.status, 'suspended')));
      const suspended = suspendedRows.slice(0, 1000);

      return [
        ...erased.map((r) => ({
          id: r.id,
          subtype: r.subtype,
          title: r.title,
          orphanReason: 'erased_owner' as const,
          lastSeenOwnerEmail: r.ownerEmail,
          createdAt: r.createdAt,
        })),
        ...suspended.map((r) => ({
          id: r.id,
          subtype: r.subtype,
          title: r.title,
          orphanReason: 'suspended_owner' as const,
          lastSeenOwnerEmail: r.ownerEmail,
          createdAt: r.createdAt,
        })),
      ];
    });

    return c.json({ items });
  });

// ─── Helpers ──────────────────────────────────────────────────────────────

async function resolveUserByEmailInternal(
  email: string,
): Promise<{ userId: string; email: string; displayName: string | null } | null> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return { userId: r.id, email: r.email, displayName: r.displayName };
  });
}
