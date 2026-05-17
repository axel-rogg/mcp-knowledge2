// Idempotency middleware. Reads `Idempotency-Key` header; if present and the
// (user_id, idem_key) is cached, returns the recorded response. Otherwise
// runs the handler and records the response body+status for the TTL.
//
// F-5: response bodies are stored ENCRYPTED with the per-user DEK + AAD.
// The plaintext would otherwise sit at-rest for 24h, defeating the
// envelope-encryption guarantee for read responses (which contain
// decrypted body_b64). The AAD binds user_id + idem_key so a row can't
// be replayed across users or against a different request key.

import type { MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { idempotencyRecords } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { nowMs } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';
import { buildAad } from '../lib/crypto/aad.ts';
import { decrypt, encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { serializeBlob, deserializeBlob } from '../lib/crypto/serialize.ts';
import { kms } from '../adapters/kms/index.ts';
import type { RequestContext } from '../types/domain.ts';

const IDEM_TTL_MS = 24 * 60 * 60 * 1000;

// Encrypt with a dedicated AAD record-type so an idempotency cipher
// can't be replayed into an objects-body decrypt path or vice versa.
function idemAad(userId: string, idemKey: string): Uint8Array {
  // Reuse buildAad shape: recordType|ownerId|objectId. Per ADR-0004 the
  // kind/subtype slot has been removed; we encode the idemKey directly
  // into the objectId slot so each idempotency entry has a distinct AAD
  // (preventing cross-key replay).
  return buildAad({
    recordType: 'object-revisions', // closest neutral existing record type
    ownerId: userId,
    objectId: `idempotency:${idemKey}`,
  });
}

export const idempotency: MiddlewareHandler = async (c, next) => {
  const idemKey = c.req.header('idempotency-key');
  if (!idemKey) {
    await next();
    return;
  }
  const ctx = c.get('ctx') as RequestContext | undefined;
  if (!ctx?.userId) {
    await next();
    return;
  }
  const method = c.req.method;
  // Only POST/PUT/PATCH are idempotent-cacheable
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    await next();
    return;
  }

  // 1. Check cache
  const cached = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .select()
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.userId, ctx.userId!), eq(idempotencyRecords.idemKey, idemKey)))
      .limit(1);
    return r[0] ?? null;
  });

  if (cached) {
    if (cached.expiresAt < nowMs()) {
      logger.debug({ idemKey }, 'idem record expired, re-executing');
    } else if (cached.responseBody && cached.responseStatus) {
      // F-5: decrypt the cached body with the caller's DEK.
      try {
        const dek = await kms().resolveUserDek(ctx.userId, ctx.requestId);
        const key = await importKey(dek);
        const blob = deserializeBlob(new Uint8Array(cached.responseBody));
        const plain = await decrypt(key, blob, idemAad(ctx.userId, idemKey));
        const text = new TextDecoder().decode(plain);
        // F-18: only 2xx responses are cached, and every 2xx response in
        // this service emits application/json. If a future handler ever
        // returns a different content-type for a 2xx, add a
        // response_content_type column and stop hardcoding here.
        return new Response(text, {
          status: cached.responseStatus,
          headers: {
            'content-type': 'application/json',
            'x-idempotent-replay': 'true',
          },
        });
      } catch (e) {
        logger.warn({ err: e, idemKey }, 'idempotent replay decrypt failed; re-executing');
      }
    }
  }

  await next();

  // 2. Cache successful 2xx responses only — encrypted.
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    try {
      const cloned = c.res.clone();
      const text = await cloned.text();
      const dek = await kms().resolveUserDek(ctx.userId, ctx.requestId);
      const key = await importKey(dek);
      const cipher = await encrypt(
        key,
        new TextEncoder().encode(text),
        idemAad(ctx.userId, idemKey),
      );
      const stored = new Uint8Array(serializeBlob(cipher));
      await withUserTx(ctx.userId, ctx.requestId, async (db) => {
        await db
          .insert(idempotencyRecords)
          .values({
            userId: ctx.userId!,
            idemKey,
            responseBody: stored,
            responseStatus: status,
            createdAt: nowMs(),
            expiresAt: nowMs() + IDEM_TTL_MS,
          })
          .onConflictDoNothing();
      });
    } catch (e) {
      logger.warn({ err: e, idemKey }, 'failed to record idempotency entry');
    }
  }
  return;
};
