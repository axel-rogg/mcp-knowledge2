// CipherBlob <-> bytes serialisation. Format (little-endian length-prefixed):
//   [version: u8][nonce_len: u8][nonce][ciphertext...]
// Used when storing combined ciphertext+nonce in a single column (rare; we
// store nonce separately in objects/object_revisions, but this helper is
// available for blob-storage where R2-objects must carry everything).

import type { CipherBlob } from './aes_gcm.ts';

export function serializeBlob(blob: CipherBlob): Uint8Array {
  const out = new Uint8Array(2 + blob.nonce.length + blob.ciphertext.length);
  out[0] = blob.version & 0xff;
  out[1] = blob.nonce.length & 0xff;
  out.set(blob.nonce, 2);
  out.set(blob.ciphertext, 2 + blob.nonce.length);
  return out;
}

export function deserializeBlob(bytes: Uint8Array): CipherBlob {
  if (bytes.length < 2) throw new Error('serialized blob too short');
  const version = bytes[0]!;
  const nonceLen = bytes[1]!;
  if (bytes.length < 2 + nonceLen) throw new Error('serialized blob malformed');
  const nonce = bytes.slice(2, 2 + nonceLen);
  const ciphertext = bytes.slice(2 + nonceLen);
  return { version, nonce, ciphertext };
}
