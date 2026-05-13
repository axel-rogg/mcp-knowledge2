// Object-Revision history (PLAN-architecture-v2 §2.1 — `object_revisions`).
//
// objects.current_version is incremented every time a body changes. Each
// historical body is preserved as a row in object_revisions. The
// envelope-encryption pattern matches the live row: per-user DEK + AAD
// bound to (recordType='object-revisions', ownerId, objectId).
//
// Owner-only: F-6 in the security audit tightened the RLS policy so a
// shared user cannot read pre-share revisions of an object that was
// later granted to them.

import { and, desc, eq } from 'drizzle-orm';
import { objectRevisions, objects } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest, errNotFound } from '../lib/errors.ts';
import { buildAad } from '../lib/crypto/aad.ts';
import { decrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { blobStore } from '../adapters/blob/s3.ts';
import { kms } from '../adapters/kms/internal_api.ts';
import type { ObjectKind } from '../types/domain.ts';

export interface RevisionMeta {
  version: number;
  createdAt: number;
}

export async function listRevisions(objectId: string): Promise<RevisionMeta[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db
      .select({ version: objectRevisions.version, createdAt: objectRevisions.createdAt })
      .from(objectRevisions)
      .where(eq(objectRevisions.objectId, objectId))
      .orderBy(desc(objectRevisions.version));
    return rows.map((r) => ({ version: r.version, createdAt: r.createdAt }));
  });
}

export interface RevisionBody {
  objectId: string;
  version: number;
  createdAt: number;
  body: Uint8Array;
}

export async function readRevision(objectId: string, version: number): Promise<RevisionBody> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // Pull the parent object for AAD + ownership sanity-check.
    const parentRows = await db.select().from(objects).where(eq(objects.id, objectId)).limit(1);
    const parent = parentRows[0];
    if (!parent) throw errNotFound(`object ${objectId} not found or not visible`);

    const revRows = await db
      .select()
      .from(objectRevisions)
      .where(and(eq(objectRevisions.objectId, objectId), eq(objectRevisions.version, version)))
      .limit(1);
    const rev = revRows[0];
    if (!rev) throw errNotFound(`object ${objectId} has no version ${version}`);
    if (!rev.nonce || rev.keyVersion === null || rev.keyVersion === undefined) {
      throw errBadRequest('revision is not encrypted-body-capable');
    }

    const dek = await kms().resolveUserDek(ctx.userId!, ctx.requestId);
    const key = await importKey(dek);
    const aad = buildAad({
      recordType: 'object-revisions',
      ownerId: parent.ownerId,
      objectId,
      kind: parent.kind as ObjectKind,
      subtype: parent.subtype,
    });

    let cipher: Uint8Array;
    if (rev.bodyInline) {
      cipher = rev.bodyInline;
    } else if (rev.blobKey) {
      // Path-traversal defense: only dereference blob_keys that look like
      // ours (objects/<uuid> optionally suffixed with @v<n> for revisions).
      if (!/^objects\/[0-9a-f-]{36}(@v\d+)?$/i.test(rev.blobKey)) {
        throw new Error(`refusing to dereference unexpected blob_key '${rev.blobKey}'`);
      }
      const fromBlob = await blobStore().get(rev.blobKey);
      if (!fromBlob) throw errNotFound('revision body missing from blob store');
      cipher = fromBlob;
    } else {
      throw new Error('revision has neither inline body nor blob key');
    }
    const body = await decrypt(key, { ciphertext: cipher, nonce: rev.nonce, version: rev.keyVersion }, aad);

    return { objectId, version, createdAt: rev.createdAt, body };
  });
}
