// Internal-API DEK provider (Variant B from PLAN §3.3).
//
// Calls mcp-approval2 to obtain the user's DEK. mcp-approval2 owns OpenBao
// access and audits every unwrap. mcp-knowledge2 caches the DEK in memory
// for the request lifetime only (via the per-request `resolveUserDek` call —
// each request triggers a fresh resolution, no cache).

import { loadEnv } from '../../types/env.ts';
import { errServiceUnavailable } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import type { KmsProvider } from './interface.ts';

export class InternalApiKms implements KmsProvider {
  async resolveUserDek(userId: string, requestId: string): Promise<Uint8Array> {
    const env = loadEnv();
    const url = `${env.MCP_APPROVAL_BASE_URL.replace(/\/$/, '')}/internal/v1/dek/resolve`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.MCP_APPROVAL_INTERNAL_TOKEN}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!r.ok) {
      logger.error({ status: r.status, userId }, 'dek resolve failed');
      throw errServiceUnavailable('failed to resolve user dek');
    }
    const j = (await r.json()) as { dek_b64: string };
    const dek = new Uint8Array(Buffer.from(j.dek_b64, 'base64'));
    if (dek.length !== 32) {
      throw errServiceUnavailable(`resolved dek wrong length ${dek.length}`);
    }
    return dek;
  }
}

let cached: KmsProvider | null = null;
export function kms(): KmsProvider {
  if (!cached) cached = new InternalApiKms();
  return cached;
}

export function setKmsForTest(provider: KmsProvider): void {
  cached = provider;
}
