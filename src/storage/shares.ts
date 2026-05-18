// Share-Grants — per-object ACL.
//
// Single-Tenant: shares are intra-firma. Per ADR-0004 (2026-05-15) all
// subtypes (incl. memo) are uniformly shareable — the memo-block here and
// the share_grants.resource_kind CHECK have both been removed. Wrapper
// tools can layer per-subtype share policy on top if needed (caller-side).

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { shareGrants, objects, groups, groupMembers } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { kms } from '../adapters/kms/index.ts';
import {
  unwrapGroupMaster,
  wrapPerObjectDekForGroup,
} from './group-crypto.ts';
import { lazyMigrateToPerObject } from './lazy-migration.ts';
import { requireContext } from '../lib/context.ts';
import {
  AppError,
  errBadRequest,
  errForbidden,
  errInternal,
  errNotFound,
} from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';
import type { SharePermission } from '../types/domain.ts';

export interface CreateShareInput {
  resourceId: string;
  grantedTo: string;
  scope: SharePermission;
  expiresAt?: number | null;
}

export interface ShareView {
  id: string;
  resourceId: string;
  /**
   * Phase 1: nullable seit Migration 0019 — Group-Grants haben statt grantedTo
   * ein grantedToGroupId. Phase-1-Code-Pfade behandeln User-Grants weiterhin;
   * Group-Grant-Surface kommt in den naechsten Build-Commits.
   */
  grantedTo: string | null;
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
      .select({ id: objects.id, ownerId: objects.ownerId })
      .from(objects)
      .where(eq(objects.id, input.resourceId))
      .limit(1);
    const obj = rows[0];
    if (!obj) throw errNotFound(`object ${input.resourceId} not found or not visible`);
    if (obj.ownerId !== ctx.userId) throw errForbidden('only owner can share');
    if (input.grantedTo === ctx.userId) throw errBadRequest('cannot share with yourself');

    const inserted = await db
      .insert(shareGrants)
      .values({
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

/**
 * P3a: liste alle aktiven Group-Grants an eine Group.
 *
 * RLS-Verhalten: `grants_self`-Policy (Mig 0019/0022) erlaubt Caller die
 * Zeile zu lesen wenn er Member dieser Group ist (oder grantedBy/grantedTo
 * matchet). Non-Member sehen leere Liste (kein 403, keine Existenz-Auskunft).
 *
 * Filter: revoked_at IS NULL (nur aktive Shares).
 */
export async function listSharesForGroup(groupId: string): Promise<ShareView[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db
      .select()
      .from(shareGrants)
      .where(
        and(
          eq(shareGrants.grantedToGroupId, groupId),
          isNull(shareGrants.revokedAt),
        ),
      );
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
    resourceId: r.resourceId,
    grantedTo: r.grantedTo,
    grantedBy: r.grantedBy,
    scope: r.scope as SharePermission,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  };
}

// ─── Group-Sharing (Phase 1, Item 6b) ──────────────────────────────────────
//
// PLAN-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §6
// ADR: mcp-approval2/docs/adr/0024-group-sharing-architecture.md
//
// Owner shared ein Object mit einer Group. Sequenz:
//   1. Object laden + Ownership-Check
//   2. Group laden (current-user MUSS Owner ODER aktiver Admin-Member sein)
//   3. Lazy-Migration falls dek_scheme='owner_hkdf' (Body wird re-encrypted)
//   4. Group-Master entpacken (via cache oder KMS-Unwrap)
//   5. Per-Object-DEK mit Group-Master wrappen
//   6. INSERT share_grants (RLS-RESTRICTIVE-Policy gated)

export interface CreateShareWithGroupInput {
  readonly resourceId: string;
  readonly groupId: string;
  readonly scope: SharePermission;
  readonly expiresAt?: number | null;
  /** Audit-Spur: bei Cascade-Hook gesetzt (Skill → Doc) */
  readonly viaCascadeFromObjectId?: string | null;
}

export interface GroupShareView extends ShareView {
  readonly grantedToGroupId: string;
  readonly viaCascadeFromObjectId: string | null;
  readonly groupMasterVersion: number | null;
}

export async function createShareWithGroup(
  input: CreateShareWithGroupInput,
): Promise<GroupShareView> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // 1. Object laden + Ownership-Check (Phase 1: nur Owner kann sharen)
    //    SELECT FOR UPDATE als Coordinator-Lock fuer Lazy-Migration.
    const objRows = await db
      .select()
      .from(objects)
      .where(eq(objects.id, input.resourceId))
      .for('update')
      .limit(1);
    const obj = objRows[0];
    if (!obj) throw errNotFound(`object ${input.resourceId} not found or not visible`);
    if (obj.ownerId !== ctx.userId) {
      throw errForbidden('only owner can share');
    }

    // 2. Group laden + current-user-Membership-Check
    const groupRows = await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.archivedAt)))
      .limit(1);
    const group = groupRows[0];
    if (!group) throw errNotFound(`group ${input.groupId} not found or archived`);

    // 3. Lazy-Migration falls noetig (idempotent)
    const migrationResult = await lazyMigrateToPerObject(db, obj, ctx.requestId);

    // 4. Group-Master entpacken — via current-user-Membership-Row
    //    (Owner ist initial-Admin, hat aktive Membership)
    const memberRows = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, input.groupId),
          eq(groupMembers.userId, ctx.userId!),
          isNull(groupMembers.removedAt),
        ),
      )
      .limit(1);
    const member = memberRows[0];
    if (!member) {
      throw errForbidden('only active group members can share into the group');
    }

    // Unwrap via member-KEK + AAD-Check
    const { unwrapGroupMasterFromMemberRow } = await import('./group-crypto.ts');
    const memberKek = await kms().resolveUserDek(ctx.userId!, ctx.requestId);
    const groupMaster = await unwrapGroupMasterFromMemberRow(
      member.wrappedGroupDek,
      memberKek,
      group.id,
      member.wrappedForMasterVersion,
    );

    // Sicherheits-Check: member.wrappedForMasterVersion sollte == group.masterVersion sein.
    // Falls stale (Member wurde noch nicht re-wrapped nach Rotation): abort.
    if (member.wrappedForMasterVersion !== group.masterVersion) {
      throw new AppError(
        401,
        'https://problems.knowledge2/stale-membership',
        'group membership is stale (master rotated); re-login required before sharing',
        {
          member_version: member.wrappedForMasterVersion,
          group_version: group.masterVersion,
        },
      );
    }

    // 5. Per-Object-DEK mit Group-Master wrappen
    const wrappedObjectDek = await wrapPerObjectDekForGroup(
      migrationResult.perObjectDek,
      groupMaster,
      input.resourceId,
    );

    // 6. INSERT share_grants — RLS-RESTRICTIVE 'grants_insert_group_owner_required'
    //    sichert dass nur Group-Owner Group-Grants inserten kann.
    //    ON CONFLICT-Handling fuer Diamond-Cascade-Safety: bei Cascade ist
    //    'via_cascade_from_object_id' gesetzt; gleiches (resource, group,
    //    cascade-source)-Triple gibt es nur einmal (UNIQUE-Index aus Mig 0020).
    const inserted = await db
      .insert(shareGrants)
      .values({
        resourceId: input.resourceId,
        grantedTo: null,
        grantedToGroupId: input.groupId,
        grantedBy: ctx.userId!,
        scope: input.scope,
        grantedAt: nowMs(),
        expiresAt: input.expiresAt ?? null,
        viaCascadeFromObjectId: input.viaCascadeFromObjectId ?? null,
        wrappedObjectDek,
        groupMasterVersion: group.masterVersion,
      })
      .onConflictDoNothing()
      .returning();

    const share = inserted[0];
    if (!share) {
      // Duplikat (z.B. bei wiederholtem Cascade) — keine Error, idempotent.
      // Wir holen die existing Row für consistent Return.
      const existing = await db
        .select()
        .from(shareGrants)
        .where(
          and(
            eq(shareGrants.resourceId, input.resourceId),
            eq(shareGrants.grantedToGroupId, input.groupId),
            isNull(shareGrants.revokedAt),
          ),
        )
        .limit(1);
      const existingShare = existing[0];
      if (!existingShare) {
        throw errInternal('createShareWithGroup: insert returned nothing and no existing row');
      }
      return groupShareToView(existingShare);
    }

    // 7. Visibility-Flag fuer UI-Hint
    await db
      .update(objects)
      .set({ visibility: 'shared' })
      .where(and(eq(objects.id, input.resourceId), eq(objects.visibility, 'private')));

    // 8. Cache Group-Master fuer kuenftige Reads
    await unwrapGroupMaster(
      kms(),
      group.id,
      group.masterVersion,
      group.wrappedMasterDek,
    );

    return groupShareToView(share);
  });
}

/**
 * Revoke aller share_grants die als Cascade vom parent-Object stammen.
 * Wird gerufen von `removeObjectRef` (in refs.ts) wenn ein BUNDLE_ROLES-
 * Ref entfernt wird.
 *
 * Direkte Shares (via_cascade_from IS NULL) bleiben unangetastet.
 */
export async function revokeCascadeSharesFrom(
  parentObjectId: string,
  childObjectId: string,
): Promise<number> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .update(shareGrants)
      .set({ revokedAt: nowMs() })
      .where(
        and(
          eq(shareGrants.resourceId, childObjectId),
          eq(shareGrants.viaCascadeFromObjectId, parentObjectId),
          isNull(shareGrants.revokedAt),
        ),
      )
      .returning({ id: shareGrants.id });
    return r.length;
  });
}

function groupShareToView(r: typeof shareGrants.$inferSelect): GroupShareView {
  if (!r.grantedToGroupId) {
    throw errInternal('groupShareToView called on non-group share');
  }
  return {
    id: r.id,
    resourceId: r.resourceId,
    grantedTo: r.grantedTo,
    grantedToGroupId: r.grantedToGroupId,
    grantedBy: r.grantedBy,
    scope: r.scope as SharePermission,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    viaCascadeFromObjectId: r.viaCascadeFromObjectId ?? null,
    groupMasterVersion: r.groupMasterVersion,
  };
}

// Helper used by also `or` chain — keep for parity with other storage files
export { or };
