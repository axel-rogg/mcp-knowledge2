// AS-3 K9: KMS-provider factory.
//
// Replaces the previous internal_api.ts module that delegated DEK-resolve
// to mcp-approval2. After AS-3 the service is autonomous — KMS lives
// in-stack via either OpenBao (prod default) or HKDF-local (dev fallback).
//
// Spec: PLAN-as3-autonomous.md §1.3.

import { loadEnv } from '../../types/env.ts';
import { errInternal } from '../../lib/errors.ts';
import { HkdfLocalKms } from './hkdf_local.ts';
import { OpenBaoKms } from './openbao.ts';
import type { KmsProvider } from './interface.ts';

let cached: KmsProvider | null = null;

export function kms(): KmsProvider {
  if (cached) return cached;
  const env = loadEnv();
  switch (env.KMS_PROVIDER) {
    case 'openbao':
      cached = new OpenBaoKms();
      break;
    case 'hkdf_local': {
      if (!env.KMS_MASTER_KEY_B64) {
        throw errInternal('KMS_PROVIDER=hkdf_local requires KMS_MASTER_KEY_B64');
      }
      cached = new HkdfLocalKms(env.KMS_MASTER_KEY_B64);
      break;
    }
    default: {
      // Exhaustive check — TS enum narrowing.
      const _exhaustive: never = env.KMS_PROVIDER;
      throw errInternal(`unsupported KMS_PROVIDER ${_exhaustive as string}`);
    }
  }
  return cached;
}

export function setKmsForTest(provider: KmsProvider): void {
  cached = provider;
}

export function resetKmsForTest(): void {
  cached = null;
}
