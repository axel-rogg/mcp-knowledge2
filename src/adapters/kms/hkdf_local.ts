// AS-3 K9: Local HKDF KMS adapter (dev / solo-setup fallback).
//
// Spec: PLAN-as3-autonomous.md §1.3 (KMS-adapter).
//
// SEC-K-005 Step B (2026-05-17): Per-user dek_salt mixed in. Vorher war
// salt=userId allein, d.h. Master-Leak + bekannte (public) User-IDs reichten
// um alle DEKs zu derivieren. Jetzt:
//
//   v1 (legacy):  dek = HKDF(master, salt=userId,            info='dek-v1', length=32)
//   v2 (current): dek = HKDF(master, salt=userId||dek_salt, info='dek-v2', length=32)
//
// Welche Variante zaehlt entscheidet `users.dek_salt_version`. Migration 0015
// fuegt das Spalten-Paar mit DEFAULT (1, gen_random_bytes(32)) an — heisst
// alte Rows behalten v1-Derivation bis das Re-Encrypt-Script ihre Bodies neu
// verschluesselt und version auf 2 bumped.
//
// Security properties (weaker than OpenBao on purpose):
//   * master-key leak v1 → all DEKs leak (no crypto-shredding)
//   * master-key leak v2 → Angreifer braucht zusaetzlich users.dek_salt aus DB
//   * forget-me on erase-user only achievable if the user row + master-key
//     stay distinct in the recovery surface (not the case in env-files)
//
// Use only for `NODE_ENV=development` or explicit pilot-with-shared-master
// setups. Defaults are in src/types/env.ts (K13).

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';
import { decodeKey } from '../../types/env.ts';
import { errInternal } from '../../lib/errors.ts';
import { getDekState } from '../../users/dek_state.ts';
import type { KmsProvider } from './interface.ts';

const hkdfAsync = promisify(hkdf);

const DEK_LENGTH_BYTES = 32;
const HKDF_INFO_V1 = new TextEncoder().encode('dek-v1');
const HKDF_INFO_V2 = new TextEncoder().encode('dek-v2');
// SEC-K-024: domain-separated derivation für embed-salt.
const EMBED_SALT_BYTES = 16;
const EMBED_SALT_INFO = new TextEncoder().encode('embed-salt-v1');

function buildDekSaltInput(userId: string, version: number, dekSalt: Uint8Array): Uint8Array {
  const userIdBytes = new TextEncoder().encode(userId);
  if (version >= 2) {
    // Concat userId || dek_salt. Keeping userId in the salt input preserves
    // per-user uniqueness without leaning solely on the random component.
    const combined = new Uint8Array(userIdBytes.length + dekSalt.length);
    combined.set(userIdBytes, 0);
    combined.set(dekSalt, userIdBytes.length);
    return combined;
  }
  return userIdBytes;
}

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
    const { dekSalt, version } = await getDekState(userId);
    const saltInput = buildDekSaltInput(userId, version, dekSalt);
    const info = version >= 2 ? HKDF_INFO_V2 : HKDF_INFO_V1;
    const derived = await hkdfAsync('sha256', this.masterKey, saltInput, info, DEK_LENGTH_BYTES);
    return new Uint8Array(derived as ArrayBuffer);
  }

  async resolveEmbedSalt(userId: string, _requestId: string): Promise<string> {
    const salt = new TextEncoder().encode(userId);
    const derived = await hkdfAsync('sha256', this.masterKey, salt, EMBED_SALT_INFO, EMBED_SALT_BYTES);
    return Buffer.from(derived as ArrayBuffer).toString('hex');
  }
}
