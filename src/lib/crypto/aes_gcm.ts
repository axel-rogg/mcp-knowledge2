// AES-256-GCM encrypt/decrypt with explicit AAD binding.
// Uses Web Crypto (crypto.subtle), runtime-agnostic (Node 22 native).

import { webcrypto } from 'node:crypto';

const NONCE_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

const subtle = webcrypto.subtle;

export interface CipherBlob {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  version: number;
}

export async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== 32) {
    throw new Error(`AES-256 key must be 32 bytes, got ${rawKey.length}`);
  }
  return subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
  version = 1,
): Promise<CipherBlob> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const result = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
    key,
    plaintext,
  );
  return { ciphertext: new Uint8Array(result), nonce, version };
}

export async function decrypt(
  key: CryptoKey,
  blob: CipherBlob,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: blob.nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
    key,
    blob.ciphertext,
  );
  return new Uint8Array(plain);
}

export function randomBytes(length: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(length));
}
