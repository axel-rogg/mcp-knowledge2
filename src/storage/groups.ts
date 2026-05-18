// Group-Storage-Layer (Phase 1 sharing).
//
// PLAN-Ref:  docs/plans/active/PLAN-sharing-group-phase-1.md §6
// Crypto-Review-Ref: CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md §3.3 + §3.4
// ADR: mcp-approval2/docs/adr/0024-group-sharing-architecture.md
//
// Operations:
//   - createGroup (Owner = current user, generates Group-Master via KMS,
//     wrapped-für-Owner-Member als initialer Admin-Member)
//   - listGroupsForUser (Owner + Member-of)
//   - getGroup mit Members
//   - archiveGroup (Owner only)
//   - addMember (Owner/Admin only, Email-based User-Lookup)
//   - removeMember mit Master-Rotation (CRITICAL — eine TX, FOR UPDATE auf
//     groups.id, re-wrap bleibende Members + alle aktiven share_grants)
//   - listMembers
//   - setReadAudit
//
// Hard-Cap MAX_GRANTS_PER_GROUP=1000 fuer Member-Remove (Crypto-Review §3.4).

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { groups, groupMembers, rewrapJobs, shareGrants } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { kms } from '../adapters/kms/index.ts';
import {
  generateAndWrapGroupMaster,
  invalidateGroupMasterCache,
  rotateGroupMaster,
  unwrapGroupMaster,
  unwrapGroupMasterFromMemberRow,
  unwrapPerObjectDekFromGroup,
  wrapGroupMasterForMember,
  wrapPerObjectDekForGroup,
} from './group-crypto.ts';
import { requireContext } from '../lib/context.ts';
import {
  errBadRequest,
  errForbidden,
  errInternal,
  errNotFound,
} from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';

const MAX_GRANTS_PER_GROUP_FOR_SYNC_ROTATION = 1000;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CreateGroupInput {
  readonly name: string;
  readonly description?: string;
  readonly readAuditEnabled?: boolean;
  readonly cascadeOnShareDefault?: boolean;
}

export interface GroupView {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string | null;
  readonly masterVersion: number;
  readonly readAuditEnabled: boolean;
  readonly cascadeOnShareDefault: boolean;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

export interface GroupMemberView {
  readonly groupId: string;
  readonly userId: string;
  readonly role: 'admin' | 'member';
  readonly joinedAt: number;
  readonly removedAt: number | null;
}

export interface AddMemberInput {
  readonly groupId: string;
  readonly userId: string;
  readonly role?: 'admin' | 'member';
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export async function createGroup(input: CreateGroupInput): Promise<GroupView> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  // 1. Group-Master generieren + KMS-wrappen (1× KMS-Roundtrip)
  const masterCreation = await generateAndWrapGroupMaster(kms());

  // 2. Owner-KEK
  const ownerKek = await kms().resolveUserDek(ctx.userId, ctx.requestId);

  // Note: das initiale wrappedGroupDekForOwner muss mit der echten groupId
  // im AAD wrapped sein. Da die DB groupId via gen_random_uuid() generiert,
  // wrappen wir erst nach dem INSERT mit der zurueckgegebenen ID (siehe
  // unten im correctWrap-Block).

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const inserted = await db
      .insert(groups)
      .values({
        ownerId: ctx.userId!,
        name: input.name,
        description: input.description ?? null,
        wrappedMasterDek: masterCreation.wrappedForDb,
        masterVersion: 1,
        readAuditEnabled: input.readAuditEnabled ?? false,
        cascadeOnShareDefault: input.cascadeOnShareDefault ?? true,
        createdAt: nowMs(),
      })
      .returning();
    const group = inserted[0];
    if (!group) throw errInternal('createGroup: INSERT returned no row');

    // Re-wrap Group-Master für Owner mit jetzt-bekannter groupId (AAD-fix)
    const correctWrap = await wrapGroupMasterForMember(
      masterCreation.plaintext,
      ownerKek,
      group.id,
      1,
    );

    await db.insert(groupMembers).values({
      groupId: group.id,
      userId: ctx.userId!,
      role: 'admin',
      wrappedGroupDek: correctWrap,
      wrappedForMasterVersion: 1,
      joinedAt: nowMs(),
    });

    return groupToView(group);
  });
}

export async function listGroupsForUser(): Promise<GroupView[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  // RLS-Policy 'groups_owner_or_member' lässt nur eigene + aktive-member-of
  // Groups durch.
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db
      .select()
      .from(groups)
      .where(isNull(groups.archivedAt));
    return rows.map(groupToView);
  });
}

export async function getGroup(
  groupId: string,
): Promise<{ group: GroupView; members: GroupMemberView[] }> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const groupRows = await db
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    const group = groupRows[0];
    if (!group) throw errNotFound(`group ${groupId} not found or not visible`);

    const memberRows = await db
      .select({
        groupId: groupMembers.groupId,
        userId: groupMembers.userId,
        role: groupMembers.role,
        joinedAt: groupMembers.joinedAt,
        removedAt: groupMembers.removedAt,
      })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));

    return {
      group: groupToView(group),
      members: memberRows.map((m) => ({
        groupId: m.groupId,
        userId: m.userId,
        role: m.role as 'admin' | 'member',
        joinedAt: m.joinedAt,
        removedAt: m.removedAt,
      })),
    };
  });
}

export async function archiveGroup(groupId: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const result = await db
      .update(groups)
      .set({ archivedAt: nowMs() })
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ctx.userId!)))
      .returning({ id: groups.id });
    if (result.length === 0) {
      throw errForbidden('only group owner can archive');
    }
  });
}

export async function setReadAudit(groupId: string, enabled: boolean): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const result = await db
      .update(groups)
      .set({ readAuditEnabled: enabled })
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ctx.userId!)))
      .returning({ id: groups.id });
    if (result.length === 0) {
      throw errForbidden('only group owner can change read_audit_enabled');
    }
  });
}

// ─── Member-Management ─────────────────────────────────────────────────────

export async function addMember(input: AddMemberInput): Promise<GroupMemberView> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // 1. Owner-Check + Group laden (für masterVersion + wrappedMasterDek)
    const groupRows = await db
      .select()
      .from(groups)
      .where(and(eq(groups.id, input.groupId), eq(groups.ownerId, ctx.userId!)))
      .limit(1);
    const group = groupRows[0];
    if (!group) throw errForbidden('only group owner can add members');
    if (group.archivedAt) throw errBadRequest('cannot add members to archived group');

    // 2. Group-Master entpacken via Owner-Member-Row
    const ownerMemberRows = await db
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
    const ownerMember = ownerMemberRows[0];
    if (!ownerMember) {
      throw errInternal(
        `addMember: owner ${ctx.userId} has no active membership in own group ${input.groupId}`,
      );
    }
    const ownerKek = await kms().resolveUserDek(ctx.userId!, ctx.requestId);
    const groupMaster = await unwrapGroupMasterFromMemberRow(
      ownerMember.wrappedGroupDek,
      ownerKek,
      group.id,
      group.masterVersion,
    );

    // 3. New-Member-KEK + wrap Group-Master
    const newMemberKek = await kms().resolveUserDek(input.userId, ctx.requestId);
    const wrappedForNewMember = await wrapGroupMasterForMember(
      groupMaster,
      newMemberKek,
      group.id,
      group.masterVersion,
    );

    // 4. INSERT group_members — RESTRICTIVE-RLS sorgt dafür dass nur Owner
    //    diese Row inserten darf.
    await db.insert(groupMembers).values({
      groupId: input.groupId,
      userId: input.userId,
      role: input.role ?? 'member',
      wrappedGroupDek: wrappedForNewMember,
      wrappedForMasterVersion: group.masterVersion,
      joinedAt: nowMs(),
    });

    return {
      groupId: input.groupId,
      userId: input.userId,
      role: input.role ?? 'member',
      joinedAt: nowMs(),
      removedAt: null,
    };
  });
}

/**
 * CRITICAL: Member-Remove mit Master-Rotation. Crypto-Review §3.4.
 *
 * Eine TX mit `FOR UPDATE` auf groups.id als Coordinator-Lock. Re-Wraps
 * sind reine Memory-Operationen nach 1× KMS-Wrap des neuen Masters →
 * Lock-Window <100ms bei realistic Sizes.
 *
 * Bei >MAX_GRANTS_PER_GROUP_FOR_SYNC_ROTATION = 1000 Grants: RAISE.
 * Phase 2 baut async Re-Wrap-Worker.
 */
export async function removeMember(
  groupId: string,
  userIdToRemove: string,
): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  if (userIdToRemove === ctx.userId) {
    throw errBadRequest('owner cannot remove self; archive group instead');
  }

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // 1. FOR UPDATE auf groups.id als Coordinator-Lock
    const lockedRows = await db
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .for('update')
      .limit(1);
    const group = lockedRows[0];
    if (!group) throw errNotFound(`group ${groupId} not found`);
    if (group.ownerId !== ctx.userId) {
      throw errForbidden('only group owner can remove members');
    }

    // 2. Count check: bei >MAX_GRANTS_PER_GROUP_FOR_SYNC_ROTATION wird
    //    der share_grants-Re-Wrap in einen async-Worker-Job ausgelagert
    //    (P2-7, Mig 0026). Die TX-1 rotiert dann nur Master + members +
    //    INSERTed rewrap_jobs-Row. Worker prozessiert grants in Batches.
    const grantCountRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(shareGrants)
      .where(
        and(
          eq(shareGrants.grantedToGroupId, groupId),
          isNull(shareGrants.revokedAt),
        ),
      );
    const grantCount = grantCountRows[0]?.c ?? 0;
    const useAsyncWorker = grantCount > MAX_GRANTS_PER_GROUP_FOR_SYNC_ROTATION;

    // 3. Old-Master entpacken (via Owner-Member-Row)
    const ownerMemberRows = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, ctx.userId!),
          isNull(groupMembers.removedAt),
        ),
      )
      .limit(1);
    const ownerMember = ownerMemberRows[0];
    if (!ownerMember) {
      throw errInternal(
        `removeMember: owner ${ctx.userId} has no active membership in own group ${groupId}`,
      );
    }
    const ownerKek = await kms().resolveUserDek(ctx.userId!, ctx.requestId);
    const oldMaster = await unwrapGroupMasterFromMemberRow(
      ownerMember.wrappedGroupDek,
      ownerKek,
      group.id,
      group.masterVersion,
    );

    // 4. Neuen Master generieren + KMS-wrap (1× KMS-Roundtrip)
    const newMasterCreation = await rotateGroupMaster(kms());
    const newVersion = group.masterVersion + 1;

    // 5. UPDATE groups SET wrappedMasterDek + masterVersion + rotatedAt
    await db
      .update(groups)
      .set({
        wrappedMasterDek: newMasterCreation.wrappedForDb,
        masterVersion: newVersion,
        rotatedAt: nowMs(),
      })
      .where(eq(groups.id, groupId));

    // 6. Mark removed-Member
    await db
      .update(groupMembers)
      .set({ removedAt: nowMs() })
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, userIdToRemove),
          isNull(groupMembers.removedAt),
        ),
      );

    // 7. Re-wrap fuer bleibende Members (pure-Memory, mit per-Member-KEK)
    const remainingMembers = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          isNull(groupMembers.removedAt),
          ne(groupMembers.userId, userIdToRemove),
        ),
      );
    for (const m of remainingMembers) {
      const memberKek = await kms().resolveUserDek(m.userId, ctx.requestId);
      const newWrap = await wrapGroupMasterForMember(
        newMasterCreation.plaintext,
        memberKek,
        group.id,
        newVersion,
      );
      await db
        .update(groupMembers)
        .set({
          wrappedGroupDek: newWrap,
          wrappedForMasterVersion: newVersion,
        })
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, m.userId),
          ),
        );
    }

    // 8. Re-wrap aktive share_grants.wrapped_object_dek (alter Master →
    //    neuer Master). Bei >MAX_GRANTS_PER_GROUP_FOR_SYNC_ROTATION wird
    //    das in einen async-Worker-Job ausgelagert (P2-7).
    if (useAsyncWorker) {
      // KMS-Wrap des OLD-Master fuer den Worker. Plaintext-Master wird
      // hier NICHT in der DB persistiert — nur die KMS-wrapped Form.
      const oldMasterKmsWrapped = await kms().wrapBytes(oldMaster);
      await db.insert(rewrapJobs).values({
        groupId,
        oldMasterVersion: group.masterVersion,
        newMasterVersion: newVersion,
        status: 'pending',
        totalGrants: grantCount,
        processedGrants: 0,
        batchSize: 100,
        triggeredBy: ctx.userId!,
        triggerReason: `member-remove:${userIdToRemove}`,
        createdAt: nowMs(),
        oldMasterKmsWrapped,
      });
    } else {
      const activeGrants = await db
        .select()
        .from(shareGrants)
        .where(
          and(
            eq(shareGrants.grantedToGroupId, groupId),
            isNull(shareGrants.revokedAt),
          ),
        );
      for (const g of activeGrants) {
        if (!g.wrappedObjectDek) continue;
        // Decapsulate object-DEK mit altem Master, re-wrap mit neuem
        const objectDek = await unwrapPerObjectDekFromGroup(
          g.wrappedObjectDek,
          oldMaster,
          g.resourceId,
        );
        const newWrappedObjectDek = await wrapPerObjectDekForGroup(
          objectDek,
          newMasterCreation.plaintext,
          g.resourceId,
        );
        await db
          .update(shareGrants)
          .set({
            wrappedObjectDek: newWrappedObjectDek,
            groupMasterVersion: newVersion,
          })
          .where(eq(shareGrants.id, g.id));
      }
    }

    // 9. Cache invalidieren fuer alte Master-Version
    invalidateGroupMasterCache(groupId, group.masterVersion);

    // 10. Audit-Event wird im HTTP-Route-Layer emittiert (mit Request-Context)
  });
}

/**
 * P2-4: Group-Owner-Transfer.
 *
 * Aendert `groups.owner_id` auf einen neuen User. Der neue Owner MUSS bereits
 * ein aktives Member sein (kein "drop in") — sonst kann er ohne wrappedGroupDek
 * den Master nicht entpacken.
 *
 * Aufruf-Vertrag:
 *   - Current owner ruft auf (ctx.userId == groups.owner_id Pflicht)
 *   - newOwnerUserId muss aktives Member sein
 *   - Crypto-Layer bleibt UNVERAENDERT: kein Master-Rotate, kein Re-Wrap.
 *     Owner-of-Group ist ein RLS-Authority-Bit, kein crypto-wrap-target.
 *   - Der alte Owner wird auf role='admin' Member herabgestuft (bleibt drin
 *     mit Read+Write-Access auf alle group-shared Content).
 *
 * Implications:
 *   - Neuer Owner kann ab sofort addMember/removeMember/archiveGroup/
 *     setReadAudit/createShareWithGroup ausfuehren.
 *   - Alter Owner verliert diese Privilegien (RLS-side via owns_group helper).
 *   - Beide haben weiterhin Read-/Write-Access auf alle group-shared Objects
 *     (sofern scope='write' bei Grants) — admin-role-im-Member-Sinne.
 *
 * Eine TX, FOR UPDATE auf groups.id als Coordinator-Lock.
 */
export async function transferGroupOwnership(
  groupId: string,
  newOwnerUserId: string,
): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  if (newOwnerUserId === ctx.userId) {
    throw errBadRequest('new owner must be different from current owner');
  }

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // 1. FOR UPDATE auf groups.id
    const lockedRows = await db
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .for('update')
      .limit(1);
    const group = lockedRows[0];
    if (!group) throw errNotFound(`group ${groupId} not found`);
    if (group.ownerId !== ctx.userId) {
      throw errForbidden('only group owner can transfer ownership');
    }
    if (group.archivedAt) {
      throw errBadRequest('cannot transfer ownership of archived group');
    }

    // 2. New-Owner muss aktives Member sein
    const newOwnerMemberRows = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, newOwnerUserId),
          isNull(groupMembers.removedAt),
        ),
      )
      .limit(1);
    if (newOwnerMemberRows.length === 0) {
      throw errBadRequest(
        `new owner ${newOwnerUserId} is not an active member — addMember first, then transfer`,
      );
    }

    // 3. UPDATE groups.owner_id
    await db
      .update(groups)
      .set({ ownerId: newOwnerUserId })
      .where(eq(groups.id, groupId));

    // 4. New-Owner-Member auf role='admin' setzen (idempotent)
    await db
      .update(groupMembers)
      .set({ role: 'admin' })
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, newOwnerUserId),
          isNull(groupMembers.removedAt),
        ),
      );

    // 5. Old-Owner-Member auf role='admin' (kein Member-Role-Downgrade — wer
    //    Owner war hatte Admin-Privilegien, behaelt die intern weiter).
    await db
      .update(groupMembers)
      .set({ role: 'admin' })
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, ctx.userId!),
          isNull(groupMembers.removedAt),
        ),
      );

    // 6. Cache invalidieren (Helper-Cache liest owns_group dynamisch via DB
    //    Function-Call — kein lokaler Eintrag fuer owner-id zu invalidieren.
    //    Die Group-Master-Cache-Eintraege sind weiterhin valid).
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function groupToView(r: typeof groups.$inferSelect): GroupView {
  return {
    id: r.id,
    ownerId: r.ownerId,
    name: r.name,
    description: r.description,
    masterVersion: r.masterVersion,
    readAuditEnabled: r.readAuditEnabled,
    cascadeOnShareDefault: r.cascadeOnShareDefault,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
  };
}

// Re-export für Caller die share-with-group implementieren
export { unwrapGroupMaster };
