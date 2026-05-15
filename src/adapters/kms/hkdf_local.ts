// AS-3 K9: Local HKDF KMS adapter (dev / solo-setup fallback).
//
// Spec: PLAN-as3-autonomous.md §1.3 (KMS-adapter).
//
// Derives a per-user DEK from `KMS_MASTER_KEY_B64` via HKDF-SHA256:
//   dek = HKDF(master, salt=user.id, info='dek-v1', length=32)
//
// Security properties (weaker than OpenBao on purpose):
//   * master-key leak → all DEKs leak (no crypto-shredding guarantee)
//   * forget-me on erase-user only achievable if the user row + master-key
//     stay distinct in the recovery surface (not the case in env-files)
//
// Use only for `NODE_ENV=development` or explicit pilot-with-shared-master
// setups. Defaults are in src/types/env.ts (K13).

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';
import { decodeKey } from '../../types/env.ts';
import { errInternal } from '../../lib/errors.ts';
import type { KmsProvider } from './interface.ts';

const hkdfAsync = promisify(hkdf);

const DEK_LENGTH_BYTES = 32;
const HKDF_INFO = new TextEncoder().encode('dek-v1');

export class HkdfLocalKms implements KmsProvider {
  private masterKey: Uint8Array;

  constructor(masterKeyEncoded: string) {
    const raw = decodeKey(masterKeyEncoded);
    if (!raw || raw.length !== 32) {
      throw errInternal('KMS_MASTER_KEY_B64 must decode to exactly 32 bytes');
    }
    this.masterKey = new Uint8Array(raw);
  }

  async resolveUserDek(userId: string, _requestId: string): Promise<Uint8Array> {
    const salt = new TextEncoder().encode(userId);
    const derived = await hkdfAsync('sha256', this.masterKey, salt, HKDF_INFO, DEK_LENGTH_BYTES);
    return new Uint8Array(derived as ArrayBuffer);
  }
}
