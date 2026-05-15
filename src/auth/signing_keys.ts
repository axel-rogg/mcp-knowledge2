// AS-3 K1: OAuth-facade signing-key registry.
//
// Spec: PLAN-as3-autonomous.md §1.1 (oauth_facade.ts) + §1.2 (signing_keys table).
//
// - On first call (`getActiveSigningKey`), generate an EdDSA keypair, encrypt
//   the PEM under BACKUP_MASTER_KEY (AES-256-GCM), and persist.
// - Public JWK is served via /.well-known/jwks.json.
// - Private key is loaded for signing JWTs in oauth_facade/token endpoint.
// - K-D3 rotation: 90d. `rotated_at` lets a cron mark old keys; cleanup is
//   manual for now (rotation cron lives in operator runbook, follow-up).
//
// Storage: `signing_keys` table (no RLS — admin-only writes; reads scoped
// by the auth-layer only).

import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, type KeyLike } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { signingKeys } from '../db/schema.ts';
import { decodeKey, loadEnv } from '../types/env.ts';
import { decrypt, encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { logger } from '../lib/logger.ts';
import { nowMs, uuidV4 } from '../lib/ids.ts';
import { errInternal } from '../lib/errors.ts';

export const SIGNING_ALG = 'EdDSA';
const SIGNING_CRV = 'Ed25519';

export interface ActiveKey {
  kid: string;
  alg: string;
  privateKey: KeyLike;
  publicJwk: Record<string, unknown>;
}

export interface PublishedJwk {
  kid: string;
  alg: string;
  publicJwk: Record<string, unknown>;
  active: boolean;
}

let cachedActive: ActiveKey | null = null;

function masterKeyBytes(): Uint8Array {
  const env = loadEnv();
  const raw = decodeKey(env.BACKUP_MASTER_KEY);
  if (!raw || raw.length !== 32) {
    throw errInternal('BACKUP_MASTER_KEY did not decode to 32 bytes');
  }
  return new Uint8Array(raw);
}

const PRIVATE_AAD = new TextEncoder().encode('signing_keys|private_pem|v1');

async function encryptPrivatePem(pem: string): Promise<{ ciphertext: Buffer; nonce: Uint8Array }> {
  const key = await importKey(masterKeyBytes());
  const plain = new TextEncoder().encode(pem);
  const blob = await encrypt(key, plain, PRIVATE_AAD);
  return { ciphertext: Buffer.from(blob.ciphertext), nonce: blob.nonce };
}

async function decryptPrivatePem(ciphertextB64: string, nonce: Uint8Array): Promise<string> {
  const key = await importKey(masterKeyBytes());
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const blob = {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
    version: 1,
  };
  const plain = await decrypt(key, blob, PRIVATE_AAD);
  return new TextDecoder().decode(plain);
}

/**
 * Generate + persist a fresh signing key. Returns the new row.
 * Marks any previously active key as `active=false` (atomic in tx).
 */
async function generateAndStoreKey(): Promise<ActiveKey> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, {
    crv: SIGNING_CRV,
    extractable: true,
  });
  const jwkRaw = await exportJWK(publicKey);
  const kid = uuidV4();
  const publicJwk: Record<string, unknown> = { ...jwkRaw, kid, alg: SIGNING_ALG, use: 'sig' };

  const pem = await exportPKCS8(privateKey);
  const { ciphertext, nonce } = await encryptPrivatePem(pem);

  await withAdminTx(async (db) => {
    // Deactivate currently-active keys (rotation: old keys stay in JWKS via
    // `rotated_at` window — for now we keep them all in jwks() output for
    // signature-validation window).
    await db.update(signingKeys).set({ active: false, rotatedAt: nowMs() }).where(eq(signingKeys.active, true));
    await db.insert(signingKeys).values({
      kid,
      alg: SIGNING_ALG,
      publicJwk,
      privatePem: ciphertext.toString('base64'),
      privateNonce: nonce,
      active: true,
      createdAt: nowMs(),
    });
  });

  return { kid, alg: SIGNING_ALG, privateKey, publicJwk };
}

/**
 * Load the currently-active signing key. Generates one on first call.
 * Result is in-memory cached for the process lifetime.
 */
export async function getActiveSigningKey(): Promise<ActiveKey> {
  if (cachedActive) return cachedActive;
  const row = await withAdminTx(async (db) => {
    const rows = await db.select().from(signingKeys).where(eq(signingKeys.active, true)).limit(1);
    return rows[0] ?? null;
  });
  if (!row) {
    logger.info('no active signing key found — bootstrapping');
    const fresh = await generateAndStoreKey();
    cachedActive = fresh;
    return fresh;
  }
  const pem = await decryptPrivatePem(row.privatePem, row.privateNonce);
  const privateKey = await importPKCS8(pem, row.alg);
  const active: ActiveKey = {
    kid: row.kid,
    alg: row.alg,
    privateKey,
    publicJwk: row.publicJwk as Record<string, unknown>,
  };
  cachedActive = active;
  return active;
}

/**
 * Force rotation: emit fresh key, mark old as rotated. Returns the new active
 * key. Old keys stay in the DB (and in jwks() output) — cleanup is operator's
 * task (90d-window per K-D3).
 */
export async function rotateSigningKey(): Promise<ActiveKey> {
  cachedActive = null;
  return generateAndStoreKey();
}

/**
 * Return all currently-publishable public JWKs (active + recently rotated).
 * Drives the /.well-known/jwks.json endpoint.
 *
 * K-D3 retention: keys older than ~90d (active) + 30d (post-rotation) get
 * dropped from JWKS so old tokens can't be replayed. Cleanup is a follow-up
 * cron — for now this returns all rows.
 */
export async function listPublishedJwks(): Promise<PublishedJwk[]> {
  return withAdminTx(async (db) => {
    const rows = await db
      .select({
        kid: signingKeys.kid,
        alg: signingKeys.alg,
        publicJwk: signingKeys.publicJwk,
        active: signingKeys.active,
      })
      .from(signingKeys)
      .orderBy(sql`${signingKeys.active} DESC, ${signingKeys.createdAt} DESC`);
    return rows.map((r) => ({
      kid: r.kid,
      alg: r.alg,
      publicJwk: r.publicJwk as Record<string, unknown>,
      active: r.active,
    }));
  });
}

/** Reset cache — for tests. */
export function resetSigningKeyCacheForTest(): void {
  cachedActive = null;
}
