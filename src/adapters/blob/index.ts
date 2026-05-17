// Blob-store factory — picks provider from env.BLOB_PROVIDER.
//
// Default: 's3' (works against AWS S3, Cloudflare R2, Backblaze B2, Hetzner
// Object Storage, MinIO — anything with the S3 API).
// Alternate: 'gcs' — native Google Cloud Storage via @google-cloud/storage,
// using Workload Identity Federation (no HMAC keys).
//
// Caller convention: import { blobStore, setBlobStoreForTest } from this
// file — NEVER from a concrete provider file. Provider switch is env-driven
// without code edits in callers.

import { loadEnv } from '../../types/env.ts';
import type { BlobStore } from './interface.ts';
import { S3BlobStore } from './s3.ts';
import { GcsBlobStore } from './gcs.ts';

let cached: BlobStore | null = null;

export function blobStore(): BlobStore {
  if (cached) return cached;
  const provider = loadEnv().BLOB_PROVIDER;
  switch (provider) {
    case 's3':
      cached = new S3BlobStore();
      break;
    case 'gcs':
      cached = new GcsBlobStore();
      break;
    default: {
      const _exhaustive: never = provider;
      throw new Error(`unknown BLOB_PROVIDER: ${_exhaustive}`);
    }
  }
  return cached;
}

/**
 * Override the cached blob-store. Tests use this to inject an in-memory
 * implementation so we don't need a live S3/GCS endpoint to roundtrip
 * objects whose ciphertext exceeds the 16 KB inline cap.
 */
export function setBlobStoreForTest(impl: BlobStore | null): void {
  cached = impl;
}

export type { BlobStore, PresignOptions, PutOptions } from './interface.ts';
