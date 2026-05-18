import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, importKey, randomBytes } from '../../src/lib/crypto/aes_gcm.ts';
import { buildAad } from '../../src/lib/crypto/aad.ts';
import { deserializeBlob, serializeBlob } from '../../src/lib/crypto/serialize.ts';

describe('aes-gcm', () => {
  it('round-trips arbitrary bytes', async () => {
    const key = await importKey(randomBytes(32));
    const aad = new TextEncoder().encode('test|owner|obj');
    const plain = new TextEncoder().encode('hello world');

    const blob = await encrypt(key, plain, aad);
    expect(blob.nonce.length).toBe(12);
    const out = await decrypt(key, blob, aad);
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });

  it('fails on AAD mismatch', async () => {
    const key = await importKey(randomBytes(32));
    const plain = new TextEncoder().encode('secret');
    const aadA = buildAad({
      recordType: 'objects',
      ownerId: 'user-a',
      objectId: 'obj-1',
    });
    const aadB = buildAad({
      recordType: 'objects',
      ownerId: 'user-b', // different owner
      objectId: 'obj-1',
    });
    const blob = await encrypt(key, plain, aadA);
    await expect(decrypt(key, blob, aadB)).rejects.toThrow();
  });

  it('rejects key of wrong length', async () => {
    await expect(importKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});

describe('aad', () => {
  it('serialises a stable string (ADR-0004: <recordType>|<owner>|<id>)', () => {
    const aad = buildAad({
      recordType: 'objects',
      ownerId: 'u-1',
      objectId: 'o-1',
    });
    expect(new TextDecoder().decode(aad)).toBe('objects|u-1|o-1');
  });

  it('uses the record-type discriminator for revisions vs live rows', () => {
    const aad = buildAad({
      recordType: 'object-revisions',
      ownerId: 'u-1',
      objectId: 'o-1',
    });
    expect(new TextDecoder().decode(aad)).toBe('object-revisions|u-1|o-1');
  });

  // ── Phase-1 sharing v2-Varianten (PLAN-Ref §3, Crypto-Review §5) ────────
  // dek_scheme='per_object' nutzt Per-Object-DEK (random, nicht owner-derived).
  // AAD bindet nur object_id; cross-user-Replay-Schutz kommt aus dem
  // DEK-Wrap-Pfad (Group-Master + owner_wrapped_dek), nicht aus AAD.

  it('v2: objects-v2 serialises ohne owner_id', () => {
    const aad = buildAad({
      recordType: 'objects-v2',
      objectId: 'o-1',
    });
    expect(new TextDecoder().decode(aad)).toBe('objects-v2|o-1');
  });

  it('v2: object-revisions-v2 serialises ohne owner_id', () => {
    const aad = buildAad({
      recordType: 'object-revisions-v2',
      objectId: 'o-1',
    });
    expect(new TextDecoder().decode(aad)).toBe('object-revisions-v2|o-1');
  });

  it('Domain-Separation: v1-Ciphertext mit objects-AAD nicht in v2-Slot decryptable', async () => {
    // Ein Ciphertext, der unter recordType='objects' mit ownerId verschluesselt
    // wurde, darf NICHT mit recordType='objects-v2' + selbem objectId
    // decryptable sein (auch nicht wenn der DEK identisch waere).
    const key = await importKey(randomBytes(32));
    const plain = new TextEncoder().encode('secret');
    const aadV1 = buildAad({
      recordType: 'objects',
      ownerId: 'u-1',
      objectId: 'o-1',
    });
    const aadV2 = buildAad({
      recordType: 'objects-v2',
      objectId: 'o-1',
    });

    const blob = await encrypt(key, plain, aadV1);
    // Same DEK, same objectId, but different AAD prefix → decrypt must fail.
    await expect(decrypt(key, blob, aadV2)).rejects.toThrow();
  });

  it('Domain-Separation: v2-Ciphertext nicht in v1-Slot decryptable', async () => {
    // Reverse-direction: v2-Ciphertext (random Per-Object-DEK, no ownerId)
    // darf nicht mit v1-AAD (mit ownerId) entschluesselbar sein.
    const key = await importKey(randomBytes(32));
    const plain = new TextEncoder().encode('secret');
    const aadV2 = buildAad({
      recordType: 'objects-v2',
      objectId: 'o-1',
    });
    const aadV1 = buildAad({
      recordType: 'objects',
      ownerId: 'u-1',
      objectId: 'o-1',
    });

    const blob = await encrypt(key, plain, aadV2);
    await expect(decrypt(key, blob, aadV1)).rejects.toThrow();
  });

  it('Domain-Separation: objects-v2 vs object-revisions-v2 nicht cross-decryptable', async () => {
    // Wenn ein Object und seine Revision dieselbe object_id haben (was nicht
    // passiert, aber theoretisch konstruierbar): das AAD-Prefix unterscheidet.
    const key = await importKey(randomBytes(32));
    const plain = new TextEncoder().encode('secret');
    const aadObj = buildAad({
      recordType: 'objects-v2',
      objectId: 'o-1',
    });
    const aadRev = buildAad({
      recordType: 'object-revisions-v2',
      objectId: 'o-1',
    });

    const blob = await encrypt(key, plain, aadObj);
    await expect(decrypt(key, blob, aadRev)).rejects.toThrow();
  });
});

describe('serialize', () => {
  it('round-trips a cipher blob', () => {
    const blob = {
      ciphertext: new Uint8Array([1, 2, 3, 4, 5]),
      nonce: new Uint8Array(12).fill(0xaa),
      version: 1,
    };
    const bytes = serializeBlob(blob);
    const out = deserializeBlob(bytes);
    expect(out.version).toBe(1);
    expect(out.nonce).toEqual(blob.nonce);
    expect(out.ciphertext).toEqual(blob.ciphertext);
  });
});
