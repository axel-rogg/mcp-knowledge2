// GCS-native blob-store adapter using @google-cloud/storage.
//
// Why a native adapter when the S3 adapter would also work against GCS via
// HMAC-keys?
//   - Workload Identity Federation: no long-lived HMAC keys to rotate.
//   - Native resumable uploads (not exposed via the S3 interop API).
//   - Signed URLs with shorter TTLs + IAM-conditions.
//   - Native object-lifecycle integration (the bucket-level config lives
//     in Terraform; the adapter just trusts that the bucket has the
//     right lifecycle rules set).
//
// Auth precedence (matches Google's ADC chain):
//   1. GOOGLE_APPLICATION_CREDENTIALS (file path)        — local dev
//   2. Metadata server (Cloud Run / GCE / GKE / Cloud Functions) — prod
//   3. gcloud auth application-default credentials       — local dev fallback
//
// We never read a credentials JSON from env — Workload Identity is the
// supported path. Set GCS_KEY_FILE only for local dev.

import { Storage, type Bucket } from '@google-cloud/storage';
import { loadEnv } from '../../types/env.ts';
import type { BlobStore, PresignOptions, PutOptions } from './interface.ts';

let cachedStorage: Storage | null = null;
let cachedBucket: Bucket | null = null;

function bucketHandle(): Bucket {
  if (cachedBucket) return cachedBucket;
  const env = loadEnv();
  if (!env.GCS_PROJECT_ID) {
    throw new Error('GCS_PROJECT_ID not set');
  }
  if (!env.BLOB_BUCKET) {
    throw new Error('BLOB_BUCKET not set');
  }
  cachedStorage = new Storage({
    projectId: env.GCS_PROJECT_ID,
    ...(env.GCS_KEY_FILE ? { keyFilename: env.GCS_KEY_FILE } : {}),
  });
  cachedBucket = cachedStorage.bucket(env.BLOB_BUCKET);
  return cachedBucket;
}

export class GcsBlobStore implements BlobStore {
  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    const file = bucketHandle().file(key);
    await file.save(Buffer.from(body), {
      contentType: opts?.contentType ?? 'application/octet-stream',
      resumable: false, // small payloads — resumable adds round-trip overhead
      validation: 'crc32c',
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = bucketHandle().file(key);
    try {
      const [contents] = await file.download();
      return new Uint8Array(contents);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const file = bucketHandle().file(key);
    try {
      await file.delete();
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 404) return; // idempotent — match S3 behaviour
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const file = bucketHandle().file(key);
    const [ex] = await file.exists();
    return ex;
  }

  async presignPut(key: string, opts: PresignOptions): Promise<string> {
    const file = bucketHandle().file(key);
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + opts.expiresInSeconds * 1000,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    });
    return url;
  }

  async presignGet(key: string, opts: PresignOptions): Promise<string> {
    const file = bucketHandle().file(key);
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + opts.expiresInSeconds * 1000,
    });
    return url;
  }
}
