// Object CRUD with envelope encryption.
//
// Body storage: <= 16 KB → body_inline (BYTEA), else R2 under `objects/<id>`.
// Crypto: AES-256-GCM with per-user DEK (resolved via KMS adapter per request)
//         and AAD = '<recordType>|<owner_id>|<id>|<kind>:<subtype>'.

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { objects, objectVectors, type ObjectRow } from '../db/schema.ts';
import { type Db, withUserTx } from '../db/client.ts';
import { buildAad } from '../lib/crypto/aad.ts';
import { decrypt, encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { uuidV4, nowMs } from '../lib/ids.ts';
import { blobStore } from '../adapters/blob/s3.ts';
import { kms } from '../adapters/kms/internal_api.ts';
import { embeddingAdapter } from '../adapters/embed/vertex.ts';
import { errBadRequest, errForbidden, errNotFound, AppError } from '../lib/errors.ts';
import { requireContext } from '../lib/context.ts';
import type { ObjectKind, Visibility } from '../types/domain.ts';

const INLINE_BODY_MAX = 16 * 1024;
const R2_PREFIX = 'objects/';

export interface CreateObjectInput {
  kind: ObjectKind;
  subtype?: string | null;
  title?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  triggerHints?: string | null;
  meta?: Record<string, unknown> | null;
  body: Uint8Array;
  mimeType?: string | null;
  filename?: string | null;
  visibility?: Visibility;
  embed?: boolean;
}

export interface UpdateObjectInput {
  title?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  triggerHints?: string | null;
  meta?: Record<string, unknown> | null;
  body?: Uint8Array;
  pinned?: boolean;
  archived?: boolean;
  expiresAt?: number | null;
  expectedVersion?: number;
  reEmbed?: boolean;
}

export interface ObjectView {
  id: string;
  ownerId: string;
  kind: ObjectKind;
  subtype: string | null;
  title: string | null;
  description: string | null;
  keywords: string[] | null;
  triggerHints: string | null;
  meta: Record<string, unknown> | null;
  bodySize: number;
  bodyHash: string | null;
  mimeType: string | null;
  filename: string | null;
  visibility: Visibility;
  pinned: boolean;
  archived: boolean;
  refcount: number;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

function rowToView(r: ObjectRow): ObjectView {
  return {
    id: r.id,
    ownerId: r.ownerId,
    kind: r.kind as ObjectKind,
    subtype: r.subtype,
    title: r.title,
    description: r.description,
    keywords: r.keywordsJson ? (JSON.parse(r.keywordsJson) as string[]) : null,
    triggerHints: r.triggerHints,
    meta: r.metaJson as Record<string, unknown> | null,
    bodySize: r.bodySize,
    bodyHash: r.bodyHash,
    mimeType: r.mimeType,
    filename: r.filename,
    visibility: r.visibility as Visibility,
    pinned: r.pinned,
    archived: r.archived,
    refcount: r.refcount,
    currentVersion: r.currentVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
  };
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
  return Buffer.from(h).toString('hex');
}

function composeEmbedSource(args: {
  title?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  triggerHints?: string | null;
}): string | null {
  const parts = [
    args.title,
    args.description,
    args.triggerHints,
    (args.keywords ?? []).join(' '),
  ]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  if (parts.length === 0) return null;
  return parts.join(' \n ');
}

// ─── Create ─────────────────────────────────────────────────────────────

export async function createObject(input: CreateObjectInput): Promise<ObjectView> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const id = uuidV4();
  const now = nowMs();
  const subtype = input.subtype ?? null;
  const bodyHash = await sha256Hex(input.body);

  // 1. encrypt body
  const dek = await kms().resolveUserDek(ctx.userId, ctx.requestId);
  const key = await importKey(dek);
  const aad = buildAad({
    recordType: 'objects',
    ownerId: ctx.userId,
    objectId: id,
    kind: input.kind,
    subtype,
  });
  const cipher = await encrypt(key, input.body, aad);

  // 2. inline vs r2
  let bodyInline: Uint8Array | null = null;
  let blobKey: string | null = null;
  if (cipher.ciphertext.length <= INLINE_BODY_MAX) {
    bodyInline = cipher.ciphertext;
  } else {
    blobKey = `${R2_PREFIX}${id}`;
    await blobStore().put(blobKey, cipher.ciphertext, { contentType: 'application/octet-stream' });
  }

  // F-22: description is plaintext-only (FTS-indexed). Encryption was
  // dropped in migration 0003. Sensitive content belongs in body.

  // 3. embedding (optional)
  let embedding: number[] | null = null;
  if (input.embed) {
    const source = composeEmbedSource(input);
    if (source) {
      const [vec] = await embeddingAdapter().embed([source], 'RETRIEVAL_DOCUMENT');
      embedding = vec ?? null;
    }
  }

  // 5. DB insert
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const inserted = await db
      .insert(objects)
      .values({
        id,
        ownerId: ctx.userId!,
        kind: input.kind,
        subtype,
        title: input.title ?? null,
        description: input.description ?? null,
        keywordsJson: input.keywords ? JSON.stringify(input.keywords) : null,
        triggerHints: input.triggerHints ?? null,
        metaJson: input.meta ?? null,
        bodyInline,
        blobKey,
        bodySize: input.body.length,
        bodyHash,
        mimeType: input.mimeType ?? null,
        filename: input.filename ?? null,
        visibility: input.visibility ?? 'private',
        nonce: cipher.nonce,
        keyVersion: cipher.version,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (embedding) {
      await db.insert(objectVectors).values({
        objectId: id,
        embedding,
        model: embeddingAdapter().model,
        embeddedAt: now,
      });
    }

    const row = inserted[0];
    if (!row) throw new Error('insert returned no row');
    return rowToView(row);
  });
}

// ─── Read ───────────────────────────────────────────────────────────────

export interface ReadObjectOptions {
  includeBody?: boolean;
}

export async function readObject(
  id: string,
  opts: ReadObjectOptions = {},
): Promise<{ view: ObjectView; body?: Uint8Array }> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db.select().from(objects).where(eq(objects.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw errNotFound(`object ${id} not found or not visible`);

    const view = rowToView(row);
    if (!opts.includeBody) return { view };

    // F-1: per-user-DEK + AAD-binding to row.ownerId means only the
    // owner can decrypt the body. RLS already lets a shared user see
    // the metadata row, but the body cipher is encrypted under the
    // owner's DEK, not theirs. Be explicit instead of returning a
    // confusing decrypt-failure stacktrace. Sharing-aware body
    // encryption (per-object DEK + share-wrapped) is a Phase-5+ topic.
    if (row.ownerId !== ctx.userId) {
      throw new AppError(
        501,
        'https://problems.knowledge2/shared-body-not-implemented',
        'shared body decryption is not implemented; only the owner can read the body',
        { owner_id: row.ownerId, your_id: ctx.userId },
      );
    }

    const dek = await kms().resolveUserDek(ctx.userId!, ctx.requestId);
    const key = await importKey(dek);
    const aad = buildAad({
      recordType: 'objects',
      ownerId: row.ownerId,
      objectId: row.id,
      kind: row.kind as ObjectKind,
      subtype: row.subtype,
    });
    let cipher: Uint8Array;
    if (row.bodyInline) {
      cipher = row.bodyInline;
    } else if (row.blobKey) {
      const fromBlob = await blobStore().get(row.blobKey);
      if (!fromBlob) throw errNotFound('object body missing from blob store');
      cipher = fromBlob;
    } else {
      throw new Error('object has neither inline body nor blob key');
    }
    const body = await decrypt(key, { ciphertext: cipher, nonce: row.nonce, version: row.keyVersion }, aad);

    // mark used (best-effort, separate tx not needed — same tx)
    await db.update(objects).set({ lastUsedAt: nowMs() }).where(eq(objects.id, id));

    return { view, body };
  });
}

// ─── Update ─────────────────────────────────────────────────────────────

export async function updateObject(id: string, input: UpdateObjectInput): Promise<ObjectView> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db.select().from(objects).where(eq(objects.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw errNotFound(`object ${id} not found or not visible`);

    if (input.expectedVersion !== undefined && row.currentVersion !== input.expectedVersion) {
      throw errBadRequest('version mismatch (CAS)', {
        expected: input.expectedVersion,
        actual: row.currentVersion,
      });
    }

    const updates: Partial<typeof objects.$inferInsert> = { updatedAt: nowMs() };

    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.keywords !== undefined)
      updates.keywordsJson = input.keywords ? JSON.stringify(input.keywords) : null;
    if (input.triggerHints !== undefined) updates.triggerHints = input.triggerHints;
    if (input.meta !== undefined) updates.metaJson = input.meta;
    if (input.pinned !== undefined) updates.pinned = input.pinned;
    if (input.archived !== undefined) {
      updates.archived = input.archived;
      updates.archivedAt = input.archived ? nowMs() : null;
    }
    if (input.expiresAt !== undefined) updates.expiresAt = input.expiresAt;

    if (input.body !== undefined) {
      // F-1: same restriction as readObject — shared-write would need
      // per-object DEK + re-wrapping to work. Block for now.
      if (row.ownerId !== ctx.userId) {
        throw new AppError(
          501,
          'https://problems.knowledge2/shared-body-not-implemented',
          'shared body writes are not implemented; only the owner can replace the body',
          { owner_id: row.ownerId, your_id: ctx.userId },
        );
      }
      const dek = await kms().resolveUserDek(ctx.userId!, ctx.requestId);
      const key = await importKey(dek);
      const aad = buildAad({
        recordType: 'objects',
        ownerId: row.ownerId,
        objectId: row.id,
        kind: row.kind as ObjectKind,
        subtype: row.subtype,
      });
      const cipher = await encrypt(key, input.body, aad);
      const bodyHash = await sha256Hex(input.body);

      if (cipher.ciphertext.length <= INLINE_BODY_MAX) {
        updates.bodyInline = cipher.ciphertext;
        updates.blobKey = null;
      } else {
        const blobKey = `${R2_PREFIX}${id}`;
        await blobStore().put(blobKey, cipher.ciphertext);
        updates.blobKey = blobKey;
        updates.bodyInline = null;
      }
      updates.nonce = cipher.nonce;
      updates.keyVersion = cipher.version;
      updates.bodySize = input.body.length;
      updates.bodyHash = bodyHash;
      updates.currentVersion = row.currentVersion + 1;
    }

    const ret = await db.update(objects).set(updates).where(eq(objects.id, id)).returning();
    const updated = ret[0];
    if (!updated) throw errForbidden('update blocked by RLS');

    if (input.reEmbed) {
      const source = composeEmbedSource({
        title: updates.title ?? row.title,
        description: updates.description ?? row.description,
        keywords: updates.keywordsJson
          ? (JSON.parse(updates.keywordsJson as string) as string[])
          : row.keywordsJson
            ? (JSON.parse(row.keywordsJson) as string[])
            : null,
        triggerHints: updates.triggerHints ?? row.triggerHints,
      });
      if (source) {
        const [vec] = await embeddingAdapter().embed([source], 'RETRIEVAL_DOCUMENT');
        if (vec) {
          await db
            .insert(objectVectors)
            .values({
              objectId: id,
              embedding: vec,
              model: embeddingAdapter().model,
              embeddedAt: nowMs(),
            })
            .onConflictDoUpdate({
              target: objectVectors.objectId,
              set: { embedding: vec, embeddedAt: nowMs() },
            });
        }
      }
    }

    return rowToView(updated);
  });
}

// ─── Soft-Delete ────────────────────────────────────────────────────────

export async function softDeleteObject(id: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // Filter on deletedAt IS NULL so a re-delete of an already-deleted
    // row returns 404 (the canonical "no work to do") instead of 204.
    const r = await db
      .update(objects)
      .set({ deletedAt: nowMs(), updatedAt: nowMs() })
      .where(and(eq(objects.id, id), isNull(objects.deletedAt)))
      .returning({ id: objects.id });
    if (r.length === 0) throw errNotFound(`object ${id} not found or not deletable`);
  });
}

export async function restoreObject(id: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .update(objects)
      .set({ deletedAt: null, updatedAt: nowMs() })
      .where(eq(objects.id, id))
      .returning({ id: objects.id });
    if (r.length === 0) throw errNotFound(`object ${id} not found`);
  });
}

// ─── List ───────────────────────────────────────────────────────────────

export interface ListOptions {
  kind?: ObjectKind;
  subtype?: string;
  limit?: number;
  cursor?: number; // updated_at to paginate before
}

export async function listObjects(opts: ListOptions): Promise<{ items: ObjectView[]; nextCursor: number | null }> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const conds = [isNull(objects.deletedAt)];
    if (opts.kind) conds.push(eq(objects.kind, opts.kind));
    if (opts.subtype) conds.push(eq(objects.subtype, opts.subtype));
    if (opts.cursor !== undefined) conds.push(lt(objects.updatedAt, opts.cursor));

    const rows = await db
      .select()
      .from(objects)
      .where(and(...conds))
      .orderBy(desc(objects.updatedAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToView);
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.updatedAt : null;
    return { items, nextCursor };
  });
}

// ─── Hard-Delete (admin-only via internal route) ────────────────────────

export async function hardDeleteByOwner(db: Db, ownerId: string): Promise<{
  blobsToDelete: string[];
  rowsDeleted: number;
}> {
  // Called with admin (BYPASSRLS) db connection inside an existing tx.
  const targets = await db
    .select({ id: objects.id, blobKey: objects.blobKey })
    .from(objects)
    .where(eq(objects.ownerId, ownerId));
  const blobsToDelete = targets
    .map((t) => t.blobKey)
    .filter((b): b is string => typeof b === 'string' && b.length > 0);
  const r = await db.delete(objects).where(eq(objects.ownerId, ownerId)).returning({ id: objects.id });
  return { blobsToDelete, rowsDeleted: r.length };
}

// ─── Stats / helpers ────────────────────────────────────────────────────

export async function countOwnedObjects(db: Db, ownerId: string): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(objects)
    .where(and(eq(objects.ownerId, ownerId), isNull(objects.deletedAt)));
  return r[0]?.c ?? 0;
}
