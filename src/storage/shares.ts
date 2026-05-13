// Share-Grants — per-object ACL.
//
// Single-Tenant: shares are intra-firma. Sharing scope from PLAN §4.3:
//   - doc / skill / app: shareable
//   - memo: not shareable (owner-only by RLS — share_grants.resource_kind
//           check constraint excludes 'memo')

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { shareGrants, objects } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest, errForbidden, errNotFound } from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';
import type { SharePermission, SharedResourceKind } from '../types/domain.ts';

export interface CreateShareInput {
  resourceId: string;
  grantedTo: string;
  scope: SharePermission;
  expiresAt?: number | null;
}

export interface ShareView {
  id: string;
  resourceKind: SharedResourceKind;
  resourceId: string;
  grantedTo: string;
  grantedBy: string;
  scope: SharePermission;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export async function createShare(input: CreateShareInput): Promise<ShareView> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // Look up the object: must be visible and owned by current user
    const rows = await db
      .select({ id: objects.id, kind: objects.kind, ownerId: objects.ownerId })
      .from(objects)
      .where(eq(objects.id, input.resourceId))
      .limit(1);
    const obj = rows[0];
    if (!obj) throw errNotFound(`object ${input.resourceId} not found or not visible`);
    if (obj.ownerId !== ctx.userId) throw errForbidden('only owner can share');
    if (obj.kind === 'memo') throw errBadRequest('memos are not shareable');
    if (input.grantedTo === ctx.userId) throw errBadRequest('cannot share with yourself');

    const inserted = await db
      .insert(shareGrants)
      .values({
        resourceKind: obj.kind as SharedResourceKind,
        resourceId: input.resourceId,
        grantedTo: input.grantedTo,
        grantedBy: ctx.userId!,
        scope: input.scope,
        grantedAt: nowMs(),
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    const share = inserted[0];
    if (!share) throw new Error('share insert returned no row');

    // Mark the object as 'shared' visibility (informational; RLS doesn't depend on it)
    await db
      .update(objects)
      .set({ visibility: 'shared' })
      .where(and(eq(objects.id, input.resourceId), eq(objects.visibility, 'private')));

    return shareToView(share);
  });
}

export async function listSharesForObject(resourceId: string): Promise<ShareView[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // RLS-guarded already; we additionally enforce owner-only viewing of shares list
    const rows = await db.select().from(shareGrants).where(eq(shareGrants.resourceId, resourceId));
    return rows.map(shareToView);
  });
}

export async function revokeShare(shareId: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .update(shareGrants)
      .set({ revokedAt: nowMs() })
      .where(and(eq(shareGrants.id, shareId), isNull(shareGrants.revokedAt)))
      .returning({ resourceId: shareGrants.resourceId });
    if (r.length === 0) throw errNotFound(`share ${shareId} not found or already revoked`);

    // If no active shares remain on the resource, flip visibility back to 'private'
    const resourceId = r[0]!.resourceId;
    const remaining = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(shareGrants)
      .where(and(eq(shareGrants.resourceId, resourceId), isNull(shareGrants.revokedAt)));
    if ((remaining[0]?.c ?? 0) === 0) {
      await db
        .update(objects)
        .set({ visibility: 'private' })
        .where(eq(objects.id, resourceId));
    }
  });
}

export async function listSharedWithMe(): Promise<ShareView[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .select()
      .from(shareGrants)
      .where(and(eq(shareGrants.grantedTo, ctx.userId!), isNull(shareGrants.revokedAt)));
    return r.map(shareToView);
  });
}

function shareToView(r: typeof shareGrants.$inferSelect): ShareView {
  return {
    id: r.id,
    resourceKind: r.resourceKind as SharedResourceKind,
    resourceId: r.resourceId,
    grantedTo: r.grantedTo,
    grantedBy: r.grantedBy,
    scope: r.scope as SharePermission,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  };
}

// Helper used by also `or` chain — keep for parity with other storage files
export { or };
