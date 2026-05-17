// Object CRUD with envelope encryption.
//
// Body storage: <= 16 KB → body_inline (BYTEA), else R2 under `objects/<id>`.
// Crypto: AES-256-GCM with per-user DEK (resolved via KMS adapter per request)
//         and AAD = '<recordType>|<owner_id>|<id>'  (ADR-0004).

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { objects, objectRevisions, objectVectors, type ObjectRow } from '../db/schema.ts';
import { type Db, withUserTx } from '../db/client.ts';
import { buildAad } from '../lib/crypto/aad.ts';
import { decrypt, encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { uuidV4, nowMs } from '../lib/ids.ts';
import { blobStore } from '../adapters/blob/index.ts';
import { kms } from '../adapters/kms/index.ts';
import { embeddingAdapter } from '../adapters/embed/index.ts';
import { errBadRequest, errForbidden, errNotFound, AppError } from '../lib/errors.ts';
import { requireContext } from '../lib/context.ts';
import type { Visibility } from '../types/domain.ts';

const INLINE_BODY_MAX = 16 * 1024;
const R2_PREFIX = 'objects/';
// UUID v4 hex shape — the only blob_key shape we mint. Anything else
// inside the column is a corruption / migration error / SQL-injection-shaped
// row that we will not dereference.
const BLOB_KEY_SHAPE = /^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(@v\d+)?$/i;

/**
 * Validate that a blob_key value is one we would have generated. Catches
 * any path-traversal-shaped value before it's passed to the BlobStore.
 *
 * Throws on mismatch — callers should let the error bubble; an unexpected
 * blob_key is a hard integrity failure, not user input.
 */
function assertBlobKeyShape(blobKey: string, context: string): void {
  if (!BLOB_KEY_SHAPE.test(blobKey)) {
    throw new Error(`refusing to dereference unexpected blob_key '${blobKey}' (${context})`);
  }
}

export interface CreateObjectInput {
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
  });
  const cipher = await encrypt(key, input.body, aad);

  // 2. inline vs r2
  let bodyInline: Uint8Array | null = null;
  let blobKey: string | null = null;
  if (cipher.ciphertext.length <= INLINE_BODY_MAX) {
    bodyInline = cipher.ciphertext;
  } else {
    blobKey = `${R2_PREFIX}${id}`;
    // SEC-K-026: defense-in-depth — assert blobKey-Shape vor put. id ist
    // UUID via Schema-Default, aber falls Wrapper künftig id aus Request-
    // Body uebernehmen ohne UUID-Check waere das Path-Traversal-Risk.
    assertBlobKeyShape(blobKey, 'createObject');
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

// ─── Lookup helpers (dedup) ─────────────────────────────────────────────

/**
 * Look up an existing object by (subtype?, bodyHash) for the current user.
 * Used by upstream tool layers (e.g. wrapper-level docs.put) to deduplicate
 * content-addressable uploads — if the same bytes already exist, return
 * the existing id instead of inserting a second row.
 *
 * RLS scopes the lookup to the caller automatically; no cross-user
 * dedup is possible (and should not be — that would leak presence).
 */
export async function getObjectByBodyHash(
  bodyHash: string,
  subtype?: string,
): Promise<ObjectView | null> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const conds = [eq(objects.bodyHash, bodyHash), isNull(objects.deletedAt)];
    if (subtype !== undefined) conds.push(eq(objects.subtype, subtype));
    const rows = await db
      .select()
      .from(objects)
      .where(and(...conds))
      .limit(1);
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

/**
 * Look up an existing object by JSON-meta path == value, optionally scoped
 * to a subtype. Used by upstream tool layers (e.g. wrapper-level
 * skills.attach_resource → find by meta_json.slug) when natural keys live
 * in meta rather than as first-class columns.
 *
 * `metaKey` is a single top-level key (no dotted paths) for safety.
 */
export async function getObjectByMeta(
  metaKey: string,
  metaValue: string,
  subtype?: string,
): Promise<ObjectView | null> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  // Restrict the key to identifier-shape to keep this away from any
  // sql-injection class even though we already parametrise.
  if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(metaKey)) {
    throw errBadRequest(`invalid metaKey '${metaKey}'`);
  }
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const conds = [
      isNull(objects.deletedAt),
      sql`${objects.metaJson} ->> ${metaKey} = ${metaValue}`,
    ];
    if (subtype !== undefined) conds.push(eq(objects.subtype, subtype));
    const rows = await db
      .select()
      .from(objects)
      .where(and(...conds))
      .limit(1);
    return rows[0] ? rowToView(rows[0]) : null;
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

    // SEC-K-025: include_body=true lädt komplette Ciphertext + plaintext in
    // RAM. Auf shared-cpu-1x (512 MB) ist alles > paar MB OOM-Risk. 1 MB
    // ist großzügig für Text-Objects (~250 Seiten Markdown), kappt aber
    // mediafile-OOM. Bei größeren Bodies → presign_get-Pfad nutzen
    // (Future, siehe Audit-Empfehlung).
    const INCLUDE_BODY_MAX_BYTES = 1024 * 1024; // 1 MB
    if (row.bodySize > INCLUDE_BODY_MAX_BYTES) {
      throw new AppError(
        413,
        'https://problems.knowledge2/body-too-large-for-include',
        `body size ${row.bodySize} exceeds include_body limit ${INCLUDE_BODY_MAX_BYTES} — fetch via presign_get`,
        { body_size: row.bodySize, limit: INCLUDE_BODY_MAX_BYTES },
      );
    }

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
    });
    let cipher: Uint8Array;
    if (row.bodyInline) {
      cipher = row.bodyInline;
    } else if (row.blobKey) {
      assertBlobKeyShape(row.blobKey, `readObject ${row.id}`);
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
      });
      const cipher = await encrypt(key, input.body, aad);
      const bodyHash = await sha256Hex(input.body);

      if (cipher.ciphertext.length <= INLINE_BODY_MAX) {
        updates.bodyInline = cipher.ciphertext;
        updates.blobKey = null;
      } else {
        const blobKey = `${R2_PREFIX}${id}`;
        // SEC-K-026: defense-in-depth — analog createObject.
        assertBlobKeyShape(blobKey, 'updateObject');
        await blobStore().put(blobKey, cipher.ciphertext);
        updates.blobKey = blobKey;
        updates.bodyInline = null;
      }
      updates.nonce = cipher.nonce;
      updates.keyVersion = cipher.version;
      updates.bodySize = input.body.length;
      updates.bodyHash = bodyHash;
      updates.currentVersion = row.currentVersion + 1;

      // Persist the OLD body as a revision before we overwrite. Note: row.*
      // here is the pre-update snapshot. Encryption details (nonce,
      // key_version, body_inline / blob_key) carry over as-is, so the
      // revision is decryptable with the same DEK+AAD that decoded it as
      // the live row originally.
      await db.insert(objectRevisions).values({
        objectId: id,
        version: row.currentVersion,
        bodyInline: row.bodyInline ?? null,
        blobKey: row.blobKey ?? null,
        metaJson: row.metaJson ?? null,
        nonce: row.nonce,
        keyVersion: row.keyVersion,
        createdAt: nowMs(),
      });
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
  subtype?: string;
  /**
   * Prefix-match filter for `subtype` (left-anchored `LIKE 'prefix%'`).
   * The Postgres B-Tree index on `(owner_id, subtype)` supports this
   * pattern shape without modification because the prefix is literal
   * (no leading `%`).
   *
   * Mutually exclusive with `subtype` — the caller (REST/MCP layer)
   * enforces 400 BAD_REQUEST. Passing both here is a programming error;
   * we throw to make it visible early.
   */
  subtypePrefix?: string;
  limit?: number;
  cursor?: number; // updated_at to paginate before
}

export async function listObjects(opts: ListOptions): Promise<{ items: ObjectView[]; nextCursor: number | null }> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  if (opts.subtype !== undefined && opts.subtypePrefix !== undefined) {
    throw errBadRequest('subtype and subtypePrefix are mutually exclusive');
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const conds = [isNull(objects.deletedAt)];
    if (opts.subtype) {
      conds.push(eq(objects.subtype, opts.subtype));
    } else if (opts.subtypePrefix) {
      // Left-anchored LIKE — the literal prefix lets Postgres use the
      // B-Tree index on (owner_id, subtype). NEVER allow caller-supplied
      // `%` or `_` in the prefix; the REST/MCP regex restricts to
      // [a-z0-9_:-] so wildcard chars cannot reach this line.
      conds.push(sql`${objects.subtype} LIKE ${opts.subtypePrefix + '%'}`);
    }
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
