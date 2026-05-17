// SEC-K-016 + MUSS-§4.1.2: Erase-Receipt-JWS verification.
//
// approval2 signiert pro echtem User-Erasure einen kurzlebigen JWT mit
// `payload.sub = <user_id>` + `approval_id` + `jti`. mcp-knowledge2 verifiziert
// gegen `MCP_APPROVAL_JWKS_URL` (selbe trust-root wie OBO), enforced
// `payload.sub === body.user_id` und checkt `jti` gegen die obo_jti_seen-Table
// (existiert seit Migration 0013).
//
// Damit reicht ein gestohlenes `SERVICE_TOKEN_ERASE` allein nicht mehr fuer
// beliebige Erasures. Der Angreifer braeuchte zusaetzlich approval2's
// RS256-Signing-Key — Defense-in-Depth gegen Service-Token-Leak.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../types/env.ts';
import { withAdminTx } from '../db/client.ts';
import { oboJtiSeen } from '../db/schema.ts';
import { errBadRequest, errForbidden, errUnauthorized } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';

const ALLOWED_JWT_ALGORITHMS = ['RS256', 'ES256'] as const;
const ERASE_RECEIPT_AUDIENCE = 'mcp-knowledge2:erase';
// JTI lebt 10min im Replay-Window — erase ist nicht hot-path, lange TTL
// kostet nichts, schuetzt aber gegen retried-token-Race.
const JTI_TTL_MS = 10 * 60 * 1000;

interface EraseReceiptPayload extends JWTPayload {
  approval_id?: string;
}

let cachedApprovalJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedApprovalJwksUrl: string | null = null;

function approvalJwks() {
  const env = loadEnv();
  if (!env.MCP_APPROVAL_JWKS_URL) {
    throw errUnauthorized('erase-receipt mode disabled (MCP_APPROVAL_JWKS_URL not set)');
  }
  if (!cachedApprovalJwks || cachedApprovalJwksUrl !== env.MCP_APPROVAL_JWKS_URL) {
    cachedApprovalJwks = createRemoteJWKSet(new URL(env.MCP_APPROVAL_JWKS_URL), {
      cacheMaxAge: env.JWKS_CACHE_TTL_SECONDS * 1000,
      cooldownDuration: 30_000,
    });
    cachedApprovalJwksUrl = env.MCP_APPROVAL_JWKS_URL;
  }
  return cachedApprovalJwks;
}

export function resetEraseReceiptJwksCacheForTest(): void {
  cachedApprovalJwks = null;
  cachedApprovalJwksUrl = null;
}

export interface VerifiedEraseReceipt {
  subject: string;
  approvalId?: string;
  jti: string;
}

export async function verifyEraseReceipt(receiptJwt: string): Promise<VerifiedEraseReceipt> {
  const env = loadEnv();

  let payload: EraseReceiptPayload;
  try {
    const { payload: verified } = await jwtVerify(receiptJwt, approvalJwks(), {
      issuer: env.MCP_APPROVAL_ISSUER,
      audience: ERASE_RECEIPT_AUDIENCE,
      algorithms: [...ALLOWED_JWT_ALGORITHMS],
    });
    payload = verified as EraseReceiptPayload;
  } catch (e) {
    logger.warn(
      { err: { name: (e as Error).name, msg: (e as Error).message } },
      'erase-receipt verify failed',
    );
    throw errForbidden('erase-receipt signature/claims verification failed');
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (!subject) throw errBadRequest('erase-receipt missing sub claim');

  const jti = typeof payload.jti === 'string' ? payload.jti : '';
  if (!jti) throw errBadRequest('erase-receipt missing jti claim');

  // SEC-K-010 pattern: jti replay-protection via DB-uniqueness on insert.
  // Wir teilen die obo_jti_seen-Table mit OBO. PK ist `jti`, also kollidieren
  // erase-jtis nicht mit OBO-jtis solange approval2 unique jtis ausstellt
  // (UUID-V4 reicht). `userId` = subject, damit pro User-Erase eine 1:1-Spur
  // existiert die mit dem audit_log korreliert.
  const now = nowMs();
  const expAt = now + JTI_TTL_MS;
  try {
    await withAdminTx(async (db) => {
      await db.insert(oboJtiSeen).values({
        jti,
        userId: subject,
        seenAt: now,
        expAt,
      });
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
      throw errForbidden('erase-receipt jti already seen (replay)');
    }
    throw e;
  }

  return {
    subject,
    approvalId: typeof payload.approval_id === 'string' ? payload.approval_id : undefined,
    jti,
  };
}

// Best-effort cleanup of expired jti rows. Cron-callable.
// (Lifecycle owned by the same sweeper that cleans OBO-jtis.)
export async function purgeExpiredEraseReceiptJtis(): Promise<number> {
  const now = nowMs();
  return withAdminTx(async (db) => {
    const r = await db.delete(oboJtiSeen).where(eq(oboJtiSeen.expAt, now)).returning({ jti: oboJtiSeen.jti });
    return r.length;
  });
}
