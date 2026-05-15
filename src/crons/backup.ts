// Encrypted daily backup. Spawns `pg_dump`, pipes the output through
// AES-256-GCM encryption with BACKUP_MASTER_KEY, then uploads to the blob
// store under `backup/<ts>.dump.enc`.
//
// The backup key is intentionally distinct from per-user DEKs so that a
// compromise of one user's DEK does not leak the historical backups.
//
// Backup-bucket: when env.BACKUP_BUCKET is set (and differs from BLOB_BUCKET),
// the encrypted dump is uploaded to that bucket instead — lets operators run a
// separate lifecycle policy (immutable + glacier-tier) on backups.
//
// Retention: after every successful upload, the cron lists objects under
// `backup/` in the target bucket and deletes those older than
// BACKUP_RETENTION_DAYS (default 30).

import { spawn } from 'node:child_process';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { decodeKey, loadEnv, type Env } from '../types/env.ts';
import { encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { serializeBlob } from '../lib/crypto/serialize.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';

function backupClient(env: Env): { client: S3Client; bucket: string } {
  const client = new S3Client({
    region: env.BLOB_REGION,
    endpoint: env.BLOB_ENDPOINT,
    forcePathStyle: env.BLOB_PATH_STYLE,
    credentials: {
      accessKeyId: env.BLOB_ACCESS_KEY,
      secretAccessKey: env.BLOB_SECRET_KEY,
    },
  });
  const bucket = env.BACKUP_BUCKET ?? env.BLOB_BUCKET;
  return { client, bucket };
}

export async function runBackup(): Promise<void> {
  const env = loadEnv();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const targetKey = `backup/${ts}.dump.enc`;

  // 1. pg_dump --format=custom — emit binary on stdout
  const pgDump = spawn('pg_dump', ['--format=custom', '--no-owner', env.DATABASE_ADMIN_URL]);
  const chunks: Buffer[] = [];
  pgDump.stdout.on('data', (c: Buffer) => chunks.push(c));
  // F-20: trace (not debug) — pg_dump verbose stderr lists table names and
  // row counts, which can include indirectly-PII-shaped identifiers in
  // user-content table names if we ever schema-add per-user tables. Keep
  // it below the production log-level threshold.
  pgDump.stderr.on('data', (c: Buffer) =>
    logger.trace({ stderr: c.toString() }, 'pg_dump stderr'),
  );

  const dumpResult = await new Promise<number>((resolve) => pgDump.on('close', resolve));
  if (dumpResult !== 0) {
    logger.error({ exitCode: dumpResult }, 'pg_dump failed');
    return;
  }
  const dump = Buffer.concat(chunks);

  // 2. Encrypt. The env validator already guaranteed BACKUP_MASTER_KEY
  //    decodes to 32 bytes — both base64 and hex shapes are accepted.
  const decoded = decodeKey(env.BACKUP_MASTER_KEY);
  if (!decoded || decoded.length !== 32) {
    logger.error({ length: decoded?.length ?? 0 }, 'BACKUP_MASTER_KEY decode failed');
    return;
  }
  const masterKey = new Uint8Array(decoded);
  const key = await importKey(masterKey);
  const aad = new TextEncoder().encode(`backup|${ts}`);
  const cipher = await encrypt(key, new Uint8Array(dump), aad);
  const blob = serializeBlob(cipher);

  // 3. Upload to the backup bucket (falls back to BLOB_BUCKET when
  //    BACKUP_BUCKET is unset).
  const { client, bucket } = backupClient(env);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: targetKey,
        Body: blob,
        ContentType: 'application/octet-stream',
      }),
    );
    logger.info(
      {
        bucket,
        key: targetKey,
        plaintext_bytes: dump.length,
        encrypted_bytes: blob.length,
        ts: nowMs(),
      },
      'backup uploaded',
    );
  } catch (e) {
    logger.error({ err: e, bucket, key: targetKey }, 'backup upload failed');
    return;
  }

  // 4. Retention sweep — delete backup/* older than BACKUP_RETENTION_DAYS.
  await sweepOldBackups(client, bucket, env.BACKUP_RETENTION_DAYS).catch((e) => {
    logger.error({ err: e, bucket }, 'backup retention sweep failed');
  });
}

async function sweepOldBackups(
  client: S3Client,
  bucket: string,
  retentionDays: number,
): Promise<void> {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let continuationToken: string | undefined = undefined;
  let deleted = 0;
  let scanned = 0;

  do {
    const r: {
      Contents?: _Object[];
      NextContinuationToken?: string;
    } = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'backup/',
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    continuationToken = r.NextContinuationToken;
    for (const obj of r.Contents ?? []) {
      scanned += 1;
      if (!obj.Key || !obj.LastModified) continue;
      if (obj.LastModified.getTime() >= cutoffMs) continue;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
      deleted += 1;
    }
  } while (continuationToken);

  logger.info({ bucket, retentionDays, scanned, deleted }, 'backup retention sweep done');
}
