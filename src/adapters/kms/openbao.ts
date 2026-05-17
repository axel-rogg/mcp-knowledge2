// AS-3 K9: OpenBao KMS adapter (production default).
//
// Spec: PLAN-as3-autonomous.md §1.3.
//
// Per-user DEK lives in OpenBao Transit Engine under `<transit_path>/data-key/<user_id>`.
// First call to a fresh user creates the key (auto_create), subsequent calls
// derive a fresh data-key on demand (Transit's `datakey/plaintext/<key>`-endpoint
// returns plaintext+ciphertext; we keep only plaintext in memory for the request).
//
// Why not store DEK alongside the user?
//   * Crypto-shredding: deleting the OpenBao key destroys all ciphertexts atomically.
//   * Audit: OpenBao logs every wrap/unwrap, so KC2's audit doesn't have to.
//
// Note: this implementation uses the plain-token auth path. AppRole-auth is the
// production setup (operator runbook), but the env-token works the same way for
// API calls — only the bootstrap differs.

import { loadEnv } from '../../types/env.ts';
import { errServiceUnavailable } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import type { KmsProvider } from './interface.ts';

interface DataKeyResponse {
  data: {
    plaintext: string;   // base64
    ciphertext: string;  // 'vault:v1:...'
  };
}

export class OpenBaoKms implements KmsProvider {
  async resolveUserDek(userId: string, requestId: string): Promise<Uint8Array> {
    const env = loadEnv();
    if (!env.OPENBAO_ADDR || !env.OPENBAO_TOKEN) {
      throw errServiceUnavailable('OPENBAO_ADDR / OPENBAO_TOKEN not configured');
    }
    const base = env.OPENBAO_ADDR.replace(/\/$/, '');
    const transit = env.OPENBAO_TRANSIT_PATH.replace(/^\/|\/$/g, '');
    // datakey/plaintext returns a fresh DEK each call — we wrap in our own
    // record-level AAD on the way in, so per-row freshness is preserved.
    const url = `${base}/v1/${transit}/datakey/plaintext/${encodeURIComponent(userId)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Vault-Token': env.OPENBAO_TOKEN,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ bits: 256 }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '<unreadable>');
      logger.error({ status: r.status, body, userId }, 'openbao datakey failed');
      throw errServiceUnavailable('failed to resolve user dek via openbao');
    }
    const j = (await r.json()) as DataKeyResponse;
    const dek = new Uint8Array(Buffer.from(j.data.plaintext, 'base64'));
    if (dek.length !== 32) {
      throw errServiceUnavailable(`openbao returned dek of wrong length ${dek.length}`);
    }
    return dek;
  }

  async resolveEmbedSalt(_userId: string, _requestId: string): Promise<string> {
    // SEC-K-024: OpenBao-Pfad ist seit ADR-0011 (2026-05-17) deprecated zu
    // Cloud-KMS. Wenn jemand OpenBao wieder aktiviert: hier eine derive-key-
    // Roundtrip via Transit (`transit/derive/<key>`) implementieren, oder
    // einen separaten KEY für embed-salt anlegen. Heute non-load-bearing.
    throw errServiceUnavailable(
      'OpenBao-KMS hat resolveEmbedSalt nicht implementiert (Pfad deprecated, ' +
        'Cloud-KMS ist Default seit ADR-0011)',
    );
  }
}
