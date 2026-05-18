// Group-Sharing Crypto-Helpers (Phase 1).
//
// PLAN-Ref:  docs/plans/active/PLAN-sharing-group-phase-1.md §2 (KMS-Layer)
// Crypto-Review-Ref: docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md §3+§7
// ADR: mcp-approval2/docs/adr/0024-group-sharing-architecture.md
//
// Schichten (Crypto-Review §1+§3):
//   1. Group-Master-DEK: random 32B, GCP-KMS-wrapped (`groups.wrapped_master_dek`).
//      Im Memory 5min gecacht analog `unwrapMasterKey()`-Cache.
//   2. Per-Object-DEK: random 32B pro Object (`dek_scheme='per_object'`).
//      Wrapped pro Konsument:
//        - `objects.owner_wrapped_dek` = AES-Wrap(perObjectDek, owner-KEK)
//        - `share_grants.wrapped_object_dek` = AES-Wrap(perObjectDek, groupMaster)
//   3. Member-Wrap: `group_members.wrapped_group_dek` = AES-Wrap(groupMaster, member-KEK)
//
// AAD-Konvention für Wraps (Domain-Separation):
//   `wrap|owner-dek|<owner_id>|<object_id>`
//   `wrap|group-master-for-member|<group_id>:<master_version>`
//   `wrap|object-dek-via-group|<object_id>`
//
// Format aller wrapped Bytes: [12B nonce] [ciphertext + 16B GCM-tag], gleich
// wie hkdf_local.wrapBytes(). Domain-Separation kommt durch AAD-Prefix, nicht
// durch Format.

import { webcrypto } from 'node:crypto';
import { decrypt, encrypt, importKey, randomBytes } from '../lib/crypto/aes_gcm.ts';
import type { KmsProvider } from '../adapters/kms/interface.ts';
import { errInternal } from '../lib/errors.ts';

const subtle = webcrypto.subtle;

// ─── Group-Master-Cache ─────────────────────────────────────────────────────
//
// Process-local Cache analog `unwrapMasterKey()` in cloud_kms.ts. TTL 5min:
// Reads finden den Master-Key meist in-memory (kein KMS-Roundtrip pro Read).
// Bei Member-Remove + Master-Rotation: cache invalidation via `groupId:version`-
// Key (alte Version wird einfach nicht mehr gesucht).

interface GroupMasterCacheEntry {
  readonly key: Uint8Array;
  readonly expiresAt: number;
}
const groupMasterCache = new Map<string, GroupMasterCacheEntry>();
const GROUP_MASTER_CACHE_TTL_MS = 5 * 60 * 1000;

function groupMasterCacheKey(groupId: string, masterVersion: number): string {
  return `${groupId}:${masterVersion}`;
}

/**
 * Test seam — clear cache between Test-Suites.
 */
export function resetGroupMasterCacheForTest(): void {
  groupMasterCache.clear();
}

// ─── Group-Master generieren + wrappen via KMS ─────────────────────────────

export interface GroupMasterCreation {
  readonly plaintext: Uint8Array; // 32B, lebt im Memory bis Caller fertig
  readonly wrappedForDb: Uint8Array; // → groups.wrapped_master_dek
}

/**
 * Bei Group-Create: random 32B Group-Master + GCP-KMS-wrap.
 */
export async function generateAndWrapGroupMaster(
  kms: KmsProvider,
): Promise<GroupMasterCreation> {
  const plaintext = randomBytes(32);
  const wrappedForDb = await kms.wrapBytes(plaintext);
  return { plaintext, wrappedForDb };
}

/**
 * Bei Member-Remove + Rotation: NEUE Group-Master generieren + wrappen.
 * Caller (groups-storage) muss in derselben TX alle bleibenden Members
 * re-wrappen und alle aktiven share_grants.wrapped_object_dek re-wrappen.
 */
export async function rotateGroupMaster(
  kms: KmsProvider,
): Promise<GroupMasterCreation> {
  return generateAndWrapGroupMaster(kms);
}

/**
 * Bei Read-Pfad / Member-Add / Cascade: Group-Master entpacken.
 * Process-Cache via 5min TTL (Crypto-Review §7 Variante C).
 */
export async function unwrapGroupMaster(
  kms: KmsProvider,
  groupId: string,
  masterVersion: number,
  wrappedMasterDek: Uint8Array,
): Promise<Uint8Array> {
  const ck = groupMasterCacheKey(groupId, masterVersion);
  const cached = groupMasterCache.get(ck);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }
  const plain = await kms.unwrapBytes(wrappedMasterDek);
  if (plain.length !== 32) {
    throw errInternal(
      `unwrapGroupMaster: Group-Master must be 32 bytes (got ${plain.length})`,
    );
  }
  groupMasterCache.set(ck, {
    key: plain,
    expiresAt: Date.now() + GROUP_MASTER_CACHE_TTL_MS,
  });
  return plain;
}

/**
 * Bei Member-Remove erst die alte Master-Version aus dem Cache invalidieren
 * (damit ein neuer Read nicht den alten Master sieht).
 */
export function invalidateGroupMasterCache(groupId: string, masterVersion: number): void {
  groupMasterCache.delete(groupMasterCacheKey(groupId, masterVersion));
}

// ─── AES-Wrap-Helpers (pure-Memory, kein KMS-Roundtrip) ────────────────────
//
// Alle Wraps sind AES-256-GCM:
//   - input = 32B Plaintext (DEK oder Master)
//   - key = 32B (Member-KEK, Owner-KEK oder Group-Master)
//   - AAD = Domain-Separation-String
//   - output = [12B nonce | ciphertext + 16B tag]  (Länge = 12 + 32 + 16 = 60B)

async function wrapWithKey(
  plaintext: Uint8Array,
  wrappingKey: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (wrappingKey.length !== 32) {
    throw errInternal(`wrapWithKey: wrapping key must be 32 bytes (got ${wrappingKey.length})`);
  }
  const key = await importKey(wrappingKey);
  const blob = await encrypt(key, plaintext, aad);
  const out = new Uint8Array(12 + blob.ciphertext.byteLength);
  out.set(blob.nonce, 0);
  out.set(blob.ciphertext, 12);
  return out;
}

async function unwrapWithKey(
  wrapped: Uint8Array,
  wrappingKey: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (wrapped.length < 12 + 16) {
    throw errInternal(`unwrapWithKey: wrapped bytes too short (${wrapped.length})`);
  }
  if (wrappingKey.length !== 32) {
    throw errInternal(`unwrapWithKey: wrapping key must be 32 bytes (got ${wrappingKey.length})`);
  }
  const key = await importKey(wrappingKey);
  const nonce = wrapped.subarray(0, 12);
  const ciphertext = wrapped.subarray(12);
  return decrypt(key, { ciphertext, nonce, version: 1 }, aad);
}

// ─── Owner-Wrap (für objects.owner_wrapped_dek) ────────────────────────────

function aadOwnerWrap(ownerId: string, objectId: string): Uint8Array {
  return new TextEncoder().encode(`wrap|owner-dek|${ownerId}|${objectId}`);
}

export async function wrapPerObjectDekForOwner(
  perObjectDek: Uint8Array,
  ownerKek: Uint8Array,
  ownerId: string,
  objectId: string,
): Promise<Uint8Array> {
  return wrapWithKey(perObjectDek, ownerKek, aadOwnerWrap(ownerId, objectId));
}

export async function unwrapPerObjectDekForOwner(
  ownerWrappedDek: Uint8Array,
  ownerKek: Uint8Array,
  ownerId: string,
  objectId: string,
): Promise<Uint8Array> {
  return unwrapWithKey(ownerWrappedDek, ownerKek, aadOwnerWrap(ownerId, objectId));
}

// ─── Group-Master-Wrap (für group_members.wrapped_group_dek) ───────────────

function aadGroupMemberWrap(groupId: string, masterVersion: number): Uint8Array {
  return new TextEncoder().encode(`wrap|group-master-for-member|${groupId}:${masterVersion}`);
}

export async function wrapGroupMasterForMember(
  groupMaster: Uint8Array,
  memberKek: Uint8Array,
  groupId: string,
  masterVersion: number,
): Promise<Uint8Array> {
  return wrapWithKey(groupMaster, memberKek, aadGroupMemberWrap(groupId, masterVersion));
}

export async function unwrapGroupMasterFromMemberRow(
  wrappedGroupDek: Uint8Array,
  memberKek: Uint8Array,
  groupId: string,
  masterVersion: number,
): Promise<Uint8Array> {
  return unwrapWithKey(wrappedGroupDek, memberKek, aadGroupMemberWrap(groupId, masterVersion));
}

// ─── Object-DEK-Wrap mit Group-Master (für share_grants.wrapped_object_dek) ─

function aadObjectDekViaGroup(objectId: string): Uint8Array {
  return new TextEncoder().encode(`wrap|object-dek-via-group|${objectId}`);
}

export async function wrapPerObjectDekForGroup(
  perObjectDek: Uint8Array,
  groupMaster: Uint8Array,
  objectId: string,
): Promise<Uint8Array> {
  return wrapWithKey(perObjectDek, groupMaster, aadObjectDekViaGroup(objectId));
}

export async function unwrapPerObjectDekFromGroup(
  wrappedObjectDek: Uint8Array,
  groupMaster: Uint8Array,
  objectId: string,
): Promise<Uint8Array> {
  return unwrapWithKey(wrappedObjectDek, groupMaster, aadObjectDekViaGroup(objectId));
}

// ─── Per-Object-DEK generieren ─────────────────────────────────────────────

/**
 * Bei Lazy-Migration (erstes Share eines Objects) und bei neuen Objects im
 * per_object-Modus. 32B random — nicht owner-derived (Crypto-Review §3.1).
 */
export function generatePerObjectDek(): Uint8Array {
  return randomBytes(32);
}

// ─── Test-Helper: subtle export für Mocks ──────────────────────────────────

export const _testSubtle = subtle;
