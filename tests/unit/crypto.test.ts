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
