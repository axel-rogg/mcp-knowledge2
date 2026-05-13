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
import { blobStore } from '../adapters/blob/s3.ts';
import { uuidV4, nowMs } from '../lib/ids.ts';

const UPLOAD_TTL_MS = 60 * 60 * 1000; // 1h
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
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const rows = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    const u = rows[0];
    if (!u) throw errNotFound(`upload ${id} not found`);
    if (u.status !== 'pending') {
      throw errBadRequest(`upload status is ${u.status}, cannot finalize`);
    }
    // Verify blob exists + measure size
    const body = await blobStore().get(u.blobKey);
    if (!body) throw errBadRequest('blob not uploaded');
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      throw errBadRequest(`body exceeds max ${MAX_UPLOAD_BYTES} bytes`);
    }
    const hash = await sha256Hex(body);

    const updated = await db
      .update(uploads)
      .set({
        status: 'finalized',
        bodySize: body.byteLength,
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
