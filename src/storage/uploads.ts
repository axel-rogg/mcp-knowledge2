// Presigned-upload lifecycle (PLAN §7.1 + §15).
//
// Flow:
//   POST /v1/uploads/init      — reserve an upload_id + presigned PUT URL
//   PUT  /v1/uploads/:id?sig=  — caller uploads body to blob via presigned URL
//   POST /v1/uploads/:id/finalize — caller commits the upload, becomes an object
//   GET  /v1/uploads/:id/status — probe lifecycle state

import { and, eq } from 'drizzle-orm';
import { uploads, type UploadRow } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest, errNotFound } from '../lib/errors.ts';
import { blobStore } from '../adapters/blob/index.ts';
import { uuidV4, nowMs } from '../lib/ids.ts';
import { buildAad } from '../lib/crypto/aad.ts';
import { encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { serializeBlob } from '../lib/crypto/serialize.ts';
import { kms } from '../adapters/kms/index.ts';

// F-16: keep the presigned-PUT window short. Long uploads should chunk.
const UPLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

export interface InitUploadInput {
  contentType?: string;
  meta?: Record<string, unknown>;
}

export interface InitUploadResult {
  uploadId: string;
  presignedUrl: string;
  expiresAt: number;
}

export async function initUpload(input: InitUploadInput): Promise<InitUploadResult> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  const id = uuidV4();
  const blobKey = `uploads/${id}`;
  const now = nowMs();
  const expiresAt = now + UPLOAD_TTL_MS;

  const presigned = await blobStore().presignPut(blobKey, {
    expiresInSeconds: Math.floor(UPLOAD_TTL_MS / 1000),
    contentType: input.contentType,
  });

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    await db.insert(uploads).values({
      id,
      ownerId: ctx.userId!,
      status: 'pending',
      blobKey,
      metaJson: input.meta ?? null,
      createdAt: now,
      expiresAt,
    });
  });
  return { uploadId: id, presignedUrl: presigned, expiresAt };
}

export interface UploadStatus {
  id: string;
  status: 'pending' | 'finalized' | 'expired' | 'hard_deleted';
  blobKey: string;
  bodySize: number | null;
  expiresAt: number;
}

export async function getUploadStatus(id: string): Promise<UploadStatus> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    const u = rows[0];
    if (!u) throw errNotFound(`upload ${id} not found`);
    return toStatus(u);
  });
}

function toStatus(u: UploadRow): UploadStatus {
  return {
    id: u.id,
    status: u.status as UploadStatus['status'],
    blobKey: u.blobKey,
    bodySize: u.bodySize,
    expiresAt: u.expiresAt,
  };
}

export async function finalizeUpload(id: string): Promise<UploadStatus> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  // 1. Load the upload row and the freshly-uploaded plaintext blob.
  const u = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    return rows[0] ?? null;
  });
  if (!u) throw errNotFound(`upload ${id} not found`);
  if (u.status !== 'pending') {
    throw errBadRequest(`upload status is ${u.status}, cannot finalize`);
  }
  const plain = await blobStore().get(u.blobKey);
  if (!plain) throw errBadRequest('blob not uploaded');
  if (plain.byteLength > MAX_UPLOAD_BYTES) {
    throw errBadRequest(`body exceeds max ${MAX_UPLOAD_BYTES} bytes`);
  }
  const hash = await sha256Hex(plain);

  // 2. F-3: encrypt-in-place. The plaintext is only valid in the bucket
  //    between PUT (presigned URL, ≤10 min) and finalize. After finalize
  //    the blob is a sealed AES-256-GCM cipher with AAD bound to
  //    (user, upload_id). A subsequent object-creation-from-upload pipe
  //    (TODO Phase 5+) would decrypt with this AAD and re-encrypt with
  //    the object-AAD.
  const dek = await kms().resolveUserDek(ctx.userId, ctx.requestId);
  const key = await importKey(dek);
  const aad = buildAad({
    recordType: 'objects',
    ownerId: ctx.userId,
    objectId: id, // upload_id doubles as AAD object-id slot
  });
  const cipher = await encrypt(key, plain, aad);
  const sealed = serializeBlob(cipher);
  await blobStore().put(u.blobKey, sealed, { contentType: 'application/octet-stream' });

  // 3. Mark finalized + record measured size/hash of the plaintext (not
  //    the cipher — these are properties of the original content).
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const updated = await db
      .update(uploads)
      .set({
        status: 'finalized',
        bodySize: plain.byteLength,
        bodyHash: hash,
        finalizedAt: nowMs(),
      })
      .where(and(eq(uploads.id, id), eq(uploads.status, 'pending')))
      .returning();
    const u2 = updated[0];
    if (!u2) throw errBadRequest('finalize race detected');
    return toStatus(u2);
  });
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
  return Buffer.from(h).toString('hex');
}

// Cron helpers (called from src/crons/sweep.ts)
export const UPLOAD_LIFECYCLE = { TTL_MS: UPLOAD_TTL_MS, MAX_UPLOAD_BYTES };
