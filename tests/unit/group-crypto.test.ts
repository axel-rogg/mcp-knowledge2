// Unit-Tests fuer Phase 1 Group-Sharing Crypto-Helpers.
//
// Test-Plan-Ref: docs/security/TEST-PLAN-SHARING-PHASE-1-2026-05-17.md §4
// Scope: Domain-Separation (Owner-Wrap vs Group-Wrap vs Object-DEK-via-
// Group), Group-Master-Cache-TTL, Stale-Master-Version-Detection
// (via AAD-Mismatch).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from '../../src/lib/crypto/aes_gcm.ts';
import {
  generateAndWrapGroupMaster,
  generatePerObjectDek,
  invalidateGroupMasterCache,
  resetGroupMasterCacheForTest,
  rotateGroupMaster,
  unwrapGroupMaster,
  unwrapGroupMasterFromMemberRow,
  unwrapPerObjectDekForOwner,
  unwrapPerObjectDekFromGroup,
  wrapGroupMasterForMember,
  wrapPerObjectDekForGroup,
  wrapPerObjectDekForOwner,
} from '../../src/storage/group-crypto.ts';
import type { KmsProvider } from '../../src/adapters/kms/interface.ts';

// ─── Mock-KMS ──────────────────────────────────────────────────────────────
//
// In-memory wrap/unwrap. Speichert ciphertext = plaintext + Marker damit
// wrap/unwrap-roundtrip funktioniert ohne echtes GCP-KMS.

function makeMockKms(): KmsProvider {
  const store = new Map<string, Uint8Array>();
  return {
    resolveUserDek: async () => new Uint8Array(32),
    resolveEmbedSalt: async () => '0'.repeat(32),
    wrapBytes: async (plain) => {
      const id = randomBytes(16);
      const idStr = Buffer.from(id).toString('hex');
      store.set(idStr, plain);
      // ciphertext-Format: [16B id, opaque]
      return id;
    },
    unwrapBytes: async (ct) => {
      const idStr = Buffer.from(ct).toString('hex');
      const plain = store.get(idStr);
      if (!plain) throw new Error('mock-kms: unknown ciphertext');
      return plain;
    },
  };
}

beforeEach(() => {
  resetGroupMasterCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('group-crypto: Group-Master generate + wrap/unwrap', () => {
  it('generateAndWrapGroupMaster returns 32B plaintext + wrapped', async () => {
    const kms = makeMockKms();
    const { plaintext, wrappedForDb } = await generateAndWrapGroupMaster(kms);
    expect(plaintext.length).toBe(32);
    expect(wrappedForDb.length).toBeGreaterThan(0);
  });

  it('unwrapGroupMaster roundtrip', async () => {
    const kms = makeMockKms();
    const { plaintext, wrappedForDb } = await generateAndWrapGroupMaster(kms);
    const unwrapped = await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);
    expect(unwrapped).toEqual(plaintext);
  });

  it('rotateGroupMaster erzeugt einen NEUEN Master (nicht alten)', async () => {
    const kms = makeMockKms();
    const v1 = await generateAndWrapGroupMaster(kms);
    const v2 = await rotateGroupMaster(kms);
    expect(v2.plaintext).not.toEqual(v1.plaintext);
  });
});

describe('group-crypto: Group-Master Cache (TTL 5min)', () => {
  it('zweiter unwrap-Call mit gleicher version trifft Cache (kein KMS-Roundtrip)', async () => {
    const kms = makeMockKms();
    const unwrapSpy = vi.spyOn(kms, 'unwrapBytes');
    const { wrappedForDb } = await generateAndWrapGroupMaster(kms);

    const first = await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);
    const second = await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);

    expect(second).toEqual(first);
    expect(unwrapSpy).toHaveBeenCalledTimes(1); // zweiter Call aus Cache
  });

  it('invalidateGroupMasterCache forciert KMS-Roundtrip beim naechsten Call', async () => {
    const kms = makeMockKms();
    const unwrapSpy = vi.spyOn(kms, 'unwrapBytes');
    const { wrappedForDb } = await generateAndWrapGroupMaster(kms);

    await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);
    invalidateGroupMasterCache('g-1', 1);
    await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);

    expect(unwrapSpy).toHaveBeenCalledTimes(2);
  });

  it('verschiedene Versionen haben getrennte Cache-Entries', async () => {
    const kms = makeMockKms();
    const unwrapSpy = vi.spyOn(kms, 'unwrapBytes');
    const v1 = await generateAndWrapGroupMaster(kms);
    const v2 = await rotateGroupMaster(kms);

    await unwrapGroupMaster(kms, 'g-1', 1, v1.wrappedForDb);
    await unwrapGroupMaster(kms, 'g-1', 2, v2.wrappedForDb);

    // Beide brauchten KMS-Roundtrip (verschiedene Cache-Keys)
    expect(unwrapSpy).toHaveBeenCalledTimes(2);
  });

  it('Cache-TTL: nach 5min expire wird KMS-Roundtrip neu gemacht', async () => {
    vi.useFakeTimers();
    const kms = makeMockKms();
    const unwrapSpy = vi.spyOn(kms, 'unwrapBytes');
    const { wrappedForDb } = await generateAndWrapGroupMaster(kms);

    await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);
    expect(unwrapSpy).toHaveBeenCalledTimes(1);

    // 5min + 1s vorspulen
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

    await unwrapGroupMaster(kms, 'g-1', 1, wrappedForDb);
    expect(unwrapSpy).toHaveBeenCalledTimes(2);
  });
});

describe('group-crypto: Owner-Wrap (owner_wrapped_dek)', () => {
  it('roundtrip: owner-Wrap + Unwrap mit gleicher KEK + ownerId + objectId', async () => {
    const ownerKek = randomBytes(32);
    const perObjectDek = generatePerObjectDek();
    const wrapped = await wrapPerObjectDekForOwner(perObjectDek, ownerKek, 'owner-1', 'obj-1');
    const unwrapped = await unwrapPerObjectDekForOwner(wrapped, ownerKek, 'owner-1', 'obj-1');
    expect(unwrapped).toEqual(perObjectDek);
  });

  it('AAD-Binding: andere ownerId → unwrap-fail', async () => {
    const ownerKek = randomBytes(32);
    const perObjectDek = generatePerObjectDek();
    const wrapped = await wrapPerObjectDekForOwner(perObjectDek, ownerKek, 'owner-1', 'obj-1');
    await expect(
      unwrapPerObjectDekForOwner(wrapped, ownerKek, 'owner-OTHER', 'obj-1'),
    ).rejects.toThrow();
  });

  it('AAD-Binding: andere objectId → unwrap-fail', async () => {
    const ownerKek = randomBytes(32);
    const perObjectDek = generatePerObjectDek();
    const wrapped = await wrapPerObjectDekForOwner(perObjectDek, ownerKek, 'owner-1', 'obj-1');
    await expect(
      unwrapPerObjectDekForOwner(wrapped, ownerKek, 'owner-1', 'obj-OTHER'),
    ).rejects.toThrow();
  });

  it('wrap mit falscher KEK-Laenge wirft', async () => {
    const tooShort = new Uint8Array(16);
    const perObjectDek = generatePerObjectDek();
    await expect(
      wrapPerObjectDekForOwner(perObjectDek, tooShort, 'owner-1', 'obj-1'),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe('group-crypto: Member-Wrap (group_members.wrapped_group_dek)', () => {
  it('roundtrip mit gleicher Master-Version', async () => {
    const memberKek = randomBytes(32);
    const groupMaster = randomBytes(32);
    const wrapped = await wrapGroupMasterForMember(groupMaster, memberKek, 'g-1', 1);
    const unwrapped = await unwrapGroupMasterFromMemberRow(wrapped, memberKek, 'g-1', 1);
    expect(unwrapped).toEqual(groupMaster);
  });

  it('Stale-Master-Version: andere version → unwrap-fail (AAD-Mismatch)', async () => {
    const memberKek = randomBytes(32);
    const groupMaster = randomBytes(32);
    const wrapped = await wrapGroupMasterForMember(groupMaster, memberKek, 'g-1', 1);
    // Member-Row wurde mit master_version=1 wrapped, jetzt wird mit version=2 unwrapped
    // → AAD-Mismatch → Stale-Detection
    await expect(
      unwrapGroupMasterFromMemberRow(wrapped, memberKek, 'g-1', 2),
    ).rejects.toThrow();
  });

  it('Cross-Group-Block: anderes groupId → unwrap-fail', async () => {
    const memberKek = randomBytes(32);
    const groupMaster = randomBytes(32);
    const wrapped = await wrapGroupMasterForMember(groupMaster, memberKek, 'g-1', 1);
    await expect(
      unwrapGroupMasterFromMemberRow(wrapped, memberKek, 'g-OTHER', 1),
    ).rejects.toThrow();
  });
});

describe('group-crypto: Object-DEK-via-Group-Wrap (share_grants.wrapped_object_dek)', () => {
  it('roundtrip', async () => {
    const groupMaster = randomBytes(32);
    const perObjectDek = generatePerObjectDek();
    const wrapped = await wrapPerObjectDekForGroup(perObjectDek, groupMaster, 'obj-1');
    const unwrapped = await unwrapPerObjectDekFromGroup(wrapped, groupMaster, 'obj-1');
    expect(unwrapped).toEqual(perObjectDek);
  });

  it('AAD-Binding: andere objectId → unwrap-fail (Cross-Object-Replay-Block)', async () => {
    const groupMaster = randomBytes(32);
    const perObjectDek = generatePerObjectDek();
    const wrapped = await wrapPerObjectDekForGroup(perObjectDek, groupMaster, 'obj-1');
    await expect(
      unwrapPerObjectDekFromGroup(wrapped, groupMaster, 'obj-OTHER'),
    ).rejects.toThrow();
  });

  it('Cross-Group-Compromise: anderer GroupMaster → unwrap-fail', async () => {
    const groupMasterX = randomBytes(32);
    const groupMasterY = randomBytes(32);
    const perObjectDek = generatePerObjectDek();
    const wrapped = await wrapPerObjectDekForGroup(perObjectDek, groupMasterX, 'obj-1');
    // Wenn Doc-A in Group-X gesharedet ist + Group-Y-Master leakt — Group-Y kann
    // Doc-A NICHT lesen weil wrapping mit Group-X-Master geschah.
    await expect(
      unwrapPerObjectDekFromGroup(wrapped, groupMasterY, 'obj-1'),
    ).rejects.toThrow();
  });
});

describe('group-crypto: Cross-Layer Domain-Separation', () => {
  it('Owner-Wrap und Group-Wrap nicht cross-decryptable (verschiedene AAD-Prefixes)', async () => {
    // Theoretisches Szenario: per Zufall ist owner-KEK == group-Master.
    // AAD-Prefix muss trotzdem block.
    const sameKey = randomBytes(32);
    const perObjectDek = generatePerObjectDek();

    const ownerWrapped = await wrapPerObjectDekForOwner(perObjectDek, sameKey, 'u-1', 'o-1');
    // unwrap-group-context mit gleicher Key + objectId → muss fail
    await expect(
      unwrapPerObjectDekFromGroup(ownerWrapped, sameKey, 'o-1'),
    ).rejects.toThrow();

    const groupWrapped = await wrapPerObjectDekForGroup(perObjectDek, sameKey, 'o-1');
    // unwrap-owner-context mit gleicher Key + objectId → muss fail
    await expect(
      unwrapPerObjectDekForOwner(groupWrapped, sameKey, 'u-1', 'o-1'),
    ).rejects.toThrow();
  });
});

describe('group-crypto: generatePerObjectDek', () => {
  it('liefert 32-Byte random', () => {
    const a = generatePerObjectDek();
    const b = generatePerObjectDek();
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a).not.toEqual(b);
  });
});
