// BlobStore — S3-compatible blob storage abstraction.
//
// Implementations:
//   - S3BlobStore (AWS S3, R2, B2, GCS-interop, MinIO) — production
//   - InMemoryBlobStore — tests

export interface PutOptions {
  contentType?: string;
}

export interface PresignOptions {
  expiresInSeconds: number;
  contentType?: string;
}

export interface BlobStore {
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  presignPut(key: string, opts: PresignOptions): Promise<string>;
  presignGet(key: string, opts: PresignOptions): Promise<string>;
}
