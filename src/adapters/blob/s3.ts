import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv } from '../../types/env.ts';
import type { BlobStore, PresignOptions, PutOptions } from './interface.ts';

let cachedClient: S3Client | null = null;

function client(): S3Client {
  if (cachedClient) return cachedClient;
  const env = loadEnv();
  cachedClient = new S3Client({
    region: env.BLOB_REGION,
    endpoint: env.BLOB_ENDPOINT,
    forcePathStyle: env.BLOB_PATH_STYLE,
    credentials: {
      accessKeyId: env.BLOB_ACCESS_KEY,
      secretAccessKey: env.BLOB_SECRET_KEY,
    },
  });
  return cachedClient;
}

function bucket(): string {
  return loadEnv().BLOB_BUCKET;
}

export class S3BlobStore implements BlobStore {
  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    await client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      if (!r.Body) return null;
      const stream = r.Body as unknown as AsyncIterable<Uint8Array>;
      const chunks: Uint8Array[] = [];
      for await (const c of stream) chunks.push(c);
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    } catch (e) {
      const name = (e as { name?: string; Code?: string }).name ?? (e as { Code?: string }).Code;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      return true;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return false;
      throw e;
    }
  }

  async presignPut(key: string, opts: PresignOptions): Promise<string> {
    return getSignedUrl(
      client(),
      new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: opts.contentType }),
      { expiresIn: opts.expiresInSeconds },
    );
  }

  async presignGet(key: string, opts: PresignOptions): Promise<string> {
    return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
      expiresIn: opts.expiresInSeconds,
    });
  }
}

let cachedBlobStore: BlobStore | null = null;
export function blobStore(): BlobStore {
  if (!cachedBlobStore) cachedBlobStore = new S3BlobStore();
  return cachedBlobStore;
}

/**
 * Override the cached blob-store. Tests use this to inject an in-memory
 * implementation so we don't need a live S3 endpoint to roundtrip
 * objects whose ciphertext exceeds the 16 KB inline cap.
 */
export function setBlobStoreForTest(impl: BlobStore | null): void {
  cachedBlobStore = impl;
}
