/**
 * Phase 3b.2 — Group-Ownership-Crypto-Orchestration.
 *
 * Drei Ownership-Transitions für Objects (analog Google-Drive Shared-Drives):
 *
 *   1. moveObjectToGroup     User-Eigentum  → Group-Eigentum
 *   2. moveObjectToPersonal  Group-Eigentum → User-Eigentum (caller)
 *   3. transferObjectOwnership User-Eigentum → andere User-Eigentum
 *
 * Alle drei operieren auf einem SINGLE-OBJECT in einer TX:
 *   - FOR UPDATE Lock auf objects.id
 *   - Source-DEK unwrappen (per_object oder group_owned scheme)
 *   - Target-DEK wrappen (gegen anderen Owner/Master)
 *   - objects-Row update (owner_id / owning_group_id / dek_scheme / ...).
 *
 * Body-Re-Encryption ist NICHT noetig — owner_wrapped_dek aendert sich, der
 * eigentliche Body bleibt mit dem unveraenderten per_object_dek + AAD-v2
 * verschluesselt (recordType='objects-v2', objectId-only AAD ist bewusst
 * owner-agnostic, siehe AAD-v2-Design 2026-05-17).
 *
 * Plan-Ref: docs/plans/active/PLAN-generic-objects-and-group-ownership.md §3b.2
 * Crypto-Review: mcp-approval2/docs/security/CRYPTO-REVIEW-GROUP-OWNERSHIP-2026-05-18.md
 */

import { and, eq, isNull } from 'drizzle-orm';
import { withUserTx } from '../db/client.ts';
import { groups, groupMembers, objects, users } from '../db/schema.ts';
import { kms } from '../adapters/kms/index.ts';
import {
  unwrapGroupMaster,
  unwrapGroupMasterFromMemberRow,
  unwrapPerObjectDekFromGroup,
  wrapPerObjectDekForGroup,
  wrapPerObjectDekForOwner,
} from './group-crypto.ts';
import { lazyMigrateToPerObject } from './lazy-migration.ts';
import { requireContext } from '../lib/context.ts';
import {
  errBadRequest,
  errForbidden,
  errInternal,
  errNotFound,
} from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Liest einen group-Member-Row + entpackt den Group-Master via dem
 * caller-spezifischen wrappedGroupDek (analog readObject-Group-Path).
 *
 * Hard-Failure wenn caller kein aktives Member ist — Decision 1+2:
 * jedes aktive Member darf moveToGroup/moveToPersonal initiieren.
 */
async function unwrapGroupMasterForCaller(
  db: Parameters<Parameters<typeof withUserTx>[2]>[0],
  groupId: string,
  callerUserId: string,
  requestId: string,
): Promise<{ master: Uint8Array; masterVersion: number }> {
  const memberRows = await db
    .select({
      wrappedGroupDek: groupMembers.wrappedGroupDek,
      wrappedForMasterVersion: groupMembers.wrappedForMasterVersion,
      removedAt: groupMembers.removedAt,
    })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, callerUserId),
        isNull(groupMembers.removedAt),
      ),
    )
    .limit(1);
  const m = memberRows[0];
  if (!m) {
    throw errForbidden('caller is not an active member of target group');
  }
  if (!m.wrappedGroupDek || m.wrappedForMasterVersion === null) {
    throw errInternal(`group ${groupId}: member-row missing wrappedGroupDek`);
  }

  const groupRows = await db
    .select({
      masterVersion: groups.masterVersion,
      wrappedMasterDek: groups.wrappedMasterDek,
      archivedAt: groups.archivedAt,
    })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  const g = groupRows[0];
  if (!g) throw errNotFound(`group ${groupId} not found or not visible`);
  if (g.archivedAt) throw errBadRequest(`group ${groupId} is archived`);

  // Wenn member-row Master-Version != group's, ist der Member-Row stale
  // (Pending Rewrap-Job nach Member-Remove eines anderen). Hard-Block.
  if (m.wrappedForMasterVersion !== g.masterVersion) {
    throw errInternal(
      `group ${groupId}: caller member-row is at version ${m.wrappedForMasterVersion}, ` +
        `current is ${g.masterVersion} — rewrap pending`,
    );
  }

  const callerKek = await kms().resolveUserDek(callerUserId, requestId);
  const master = await unwrapGroupMasterFromMemberRow(
    m.wrappedGroupDek,
    callerKek,
    groupId,
    m.wrappedForMasterVersion,
  );
  // Sanity: re-derived master via KMS-wrappedMaster — caches via unwrapGroupMaster
  // damit naechster Read in derselben Request den Cache nutzen kann.
  await unwrapGroupMaster(kms(), groupId, g.masterVersion, g.wrappedMasterDek);
  return { master, masterVersion: g.masterVersion };
}

// ─── 1. User → Group ──────────────────────────────────────────────────────

export interface MoveObjectToGroupInput {
  readonly objectId: string;
  readonly groupId: string;
}

/**
 * Object aus persoenlichem Besitz in Team-Besitz uebertragen.
 *
 * Vorbedingungen:
 *   - caller ist current owner_id des Objects (Decision: jeder Member darf
 *     Group-Objects manipulieren — caller-of-move muss aber selber Owner sein,
 *     sonst koennten Aussenstehende meine Objects in fremde Groups schieben).
 *   - target Group existiert, ist nicht archived, caller ist aktives Member.
 *   - Object war 'owner_hkdf' oder 'per_object'. Wird zu 'group_owned'.
 */
export async function moveObjectToGroup(input: MoveObjectToGroupInput): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const callerId = ctx.userId;

  await withUserTx(callerId, ctx.requestId, async (db) => {
    // 1. Object lock + caller-is-owner-check
    const objRows = await db
      .select()
      .from(objects)
      .where(eq(objects.id, input.objectId))
      .for('update')
      .limit(1);
    const obj = objRows[0];
    if (!obj) throw errNotFound(`object ${input.objectId} not found`);
    if (obj.ownerId !== callerId) {
      // RLS sollte das bereits filtern, aber defense-in-depth.
      throw errForbidden('only owner can move object to a group');
    }
    if (obj.owningGroupId) {
      throw errBadRequest('object is already group-owned');
    }

    // 2. Lazy-Migrate auf per_object falls noch owner_hkdf (gibt uns einen
    //    randomen perObjectDek zurueck). Wir muessen das tun BEVOR wir die
    //    Group-DEK wrappen, damit der Body-AAD-v2-Schluessel da ist.
    const { perObjectDek } = await lazyMigrateToPerObject(db, obj, ctx.requestId);

    // 3. Target-Group-Master entpacken (via caller's member-row)
    const { master, masterVersion } = await unwrapGroupMasterForCaller(
      db,
      input.groupId,
      callerId,
      ctx.requestId,
    );

    // 4. Re-wrap perObjectDek mit Group-Master (AAD = wrap|object-dek-via-group|<id>)
    const groupWrappedDek = await wrapPerObjectDekForGroup(
      perObjectDek,
      master,
      input.objectId,
    );

    // 5. Atomic: ownership umschalten
    await db
      .update(objects)
      .set({
        ownerId: null,
        owningGroupId: input.groupId,
        ownerWrappedDek: groupWrappedDek,
        dekScheme: 'group_owned',
        groupMasterVersion: masterVersion,
        updatedAt: nowMs(),
      })
      .where(eq(objects.id, input.objectId));
  });
}

// ─── 2. Group → User (caller) ─────────────────────────────────────────────

export interface MoveObjectToPersonalInput {
  readonly objectId: string;
}

/**
 * Group-Eigentum -> caller-User-Eigentum.
 *
 * Vorbedingungen:
 *   - Object ist group-owned (owner_id NULL, owning_group_id NOT NULL)
 *   - caller ist aktives Mitglied der owning_group
 *   - Decision 1+2: jedes aktive Member darf move-out initiieren
 *
 * Side-Effects:
 *   - Andere Group-Members verlieren neuen Read-Access. Bereits geladene
 *     Inhalte koennen nicht zurueckgerufen werden (Crypto-Review §4 Caveat).
 *   - Group-Master wird NICHT rotiert (sonst muessten alle anderen group-
 *     owned Objects re-wrapped werden — overkill fuer single-Object-Move).
 *     User-Decision 4: das ist akzeptiert, sicher genug.
 */
export async function moveObjectToPersonal(input: MoveObjectToPersonalInput): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const callerId = ctx.userId;

  await withUserTx(callerId, ctx.requestId, async (db) => {
    const objRows = await db
      .select()
      .from(objects)
      .where(eq(objects.id, input.objectId))
      .for('update')
      .limit(1);
    const obj = objRows[0];
    if (!obj) throw errNotFound(`object ${input.objectId} not found`);
    if (!obj.owningGroupId) {
      throw errBadRequest('object is not group-owned');
    }
    if (obj.dekScheme !== 'group_owned') {
      throw errInternal(`object ${obj.id} owning_group set but dek_scheme=${obj.dekScheme}`);
    }
    if (!obj.ownerWrappedDek) {
      throw errInternal(`object ${obj.id} group-owned but owner_wrapped_dek NULL`);
    }
    if (obj.groupMasterVersion === null) {
      throw errInternal(`object ${obj.id} group-owned but group_master_version NULL`);
    }

    // caller muss aktives Mitglied sein → Master ist entpackbar
    const { master } = await unwrapGroupMasterForCaller(
      db,
      obj.owningGroupId,
      callerId,
      ctx.requestId,
    );
    // Master-Version-Drift-Check: wenn Object's wrapped-Version != current
    // Master-Version, ist der Rewrap-Worker noch nicht durch — Block.
    if (obj.groupMasterVersion !== (await currentMasterVersion(db, obj.owningGroupId))) {
      throw errBadRequest(
        `object pending master-rewrap (object=${obj.groupMasterVersion}); retry shortly`,
      );
    }

    // 1. Unwrap perObjectDek aus group-master
    const perObjectDek = await unwrapPerObjectDekFromGroup(
      obj.ownerWrappedDek,
      master,
      obj.id,
    );

    // 2. Wrap unter caller's user-KEK
    const callerKek = await kms().resolveUserDek(callerId, ctx.requestId);
    const ownerWrappedDek = await wrapPerObjectDekForOwner(
      perObjectDek,
      callerKek,
      callerId,
      obj.id,
    );

    // 3. Update
    await db
      .update(objects)
      .set({
        ownerId: callerId,
        owningGroupId: null,
        ownerWrappedDek,
        dekScheme: 'per_object',
        groupMasterVersion: null,
        ownerWrapKeyVersion: 1, // matches createObject convention
        updatedAt: nowMs(),
      })
      .where(eq(objects.id, input.objectId));
  });
}

// ─── 3. User → User (transfer) ────────────────────────────────────────────

export interface TransferObjectOwnershipInput {
  readonly objectId: string;
  readonly newOwnerUserId: string;
}

/**
 * Object an anderen User uebertragen (sensitivity='danger', Decision 9).
 *
 * Vorbedingungen:
 *   - caller ist current owner_id des Objects
 *   - newOwnerUserId existiert + ist 'active' (Decision 6: nur known Users)
 *   - Object war user-owned (nicht group-owned — Group-Transfer ist eigene
 *     Operation via groups.transfer_ownership).
 */
export async function transferObjectOwnership(
  input: TransferObjectOwnershipInput,
): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const callerId = ctx.userId;
  if (input.newOwnerUserId === callerId) {
    throw errBadRequest('new owner must differ from current owner');
  }

  // Caller-tx (RLS) locked das Object; danach holen wir new-owner's KEK
  // ueber kms().resolveUserDek — das funktioniert weil resolveUserDek
  // nicht RLS-bounded ist (KMS-Layer hat eigene Authority).
  await withUserTx(callerId, ctx.requestId, async (db) => {
    const objRows = await db
      .select()
      .from(objects)
      .where(eq(objects.id, input.objectId))
      .for('update')
      .limit(1);
    const obj = objRows[0];
    if (!obj) throw errNotFound(`object ${input.objectId} not found`);
    if (obj.ownerId !== callerId) {
      throw errForbidden('only owner can transfer object ownership');
    }
    if (obj.owningGroupId) {
      throw errBadRequest('object is group-owned; use groups.transfer-ownership');
    }

    // newOwner-Validity (Decision 6: nur known users)
    const { exists, active } = await checkUserKnownActive(db, input.newOwnerUserId);
    if (!exists) throw errBadRequest(`target user ${input.newOwnerUserId} not registered`);
    if (!active) throw errBadRequest(`target user ${input.newOwnerUserId} not active`);

    // Lazy-migrate auf per_object falls noch owner_hkdf
    const { perObjectDek } = await lazyMigrateToPerObject(db, obj, ctx.requestId);

    // Re-wrap mit new-owner-KEK
    const newOwnerKek = await kms().resolveUserDek(input.newOwnerUserId, ctx.requestId);
    const newOwnerWrappedDek = await wrapPerObjectDekForOwner(
      perObjectDek,
      newOwnerKek,
      input.newOwnerUserId,
      obj.id,
    );

    await db
      .update(objects)
      .set({
        ownerId: input.newOwnerUserId,
        ownerWrappedDek: newOwnerWrappedDek,
        dekScheme: 'per_object',
        ownerWrapKeyVersion: 1,
        updatedAt: nowMs(),
      })
      .where(eq(objects.id, input.objectId));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function currentMasterVersion(
  db: Parameters<Parameters<typeof withUserTx>[2]>[0],
  groupId: string,
): Promise<number> {
  const rows = await db
    .select({ masterVersion: groups.masterVersion })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!rows[0]) throw errNotFound(`group ${groupId} not found`);
  return rows[0].masterVersion;
}

async function checkUserKnownActive(
  db: Parameters<Parameters<typeof withUserTx>[2]>[0],
  userId: string,
): Promise<{ exists: boolean; active: boolean }> {
  // Decision 6: transfer-target muss in users-Tabelle bekannt sein.
  // RLS-Policy fuer users: caller darf id+status fuer beliebigen User
  // resolven (SELECT-Policy 'users_visible_for_resolve' — eigene Mig dazu).
  // Wenn die RLS-Policy fehlt, returnen wir 'unknown' und blocken den Move —
  // safe-default.
  try {
    const rows = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (rows.length === 0) return { exists: false, active: false };
    return { exists: true, active: rows[0]!.status === 'active' };
  } catch {
    return { exists: false, active: false };
  }
}
