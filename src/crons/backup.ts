// Encrypted daily backup. Spawns `pg_dump`, pipes the output through
// AES-256-GCM encryption with BACKUP_MASTER_KEY, then uploads to the blob
// store under `backup/<ts>.dump.enc`.
//
// The backup key is intentionally distinct from per-user DEKs so that a
// compromise of one user's DEK does not leak the historical backups.

import { spawn } from 'node:child_process';
import { decodeKey, loadEnv } from '../types/env.ts';
import { blobStore } from '../adapters/blob/s3.ts';
import { encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { serializeBlob } from '../lib/crypto/serialize.ts';
import { logger } from '../lib/logger.ts';
import { nowMs } from '../lib/ids.ts';

export async function runBackup(): Promise<void> {
  const env = loadEnv();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const targetKey = `backup/${ts}.dump.enc`;

  // 1. pg_dump --format=custom — emit binary on stdout
  const pgDump = spawn('pg_dump', ['--format=custom', '--no-owner', env.DATABASE_ADMIN_URL]);
  const chunks: Buffer[] = [];
  pgDump.stdout.on('data', (c: Buffer) => chunks.push(c));
  pgDump.stderr.on('data', (c: Buffer) =>
    logger.debug({ stderr: c.toString() }, 'pg_dump stderr'),
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

  // 3. Upload
  try {
    await blobStore().put(targetKey, blob, { contentType: 'application/octet-stream' });
    logger.info(
      { key: targetKey, plaintext_bytes: dump.length, encrypted_bytes: blob.length, ts: nowMs() },
      'backup uploaded',
    );
  } catch (e) {
    logger.error({ err: e }, 'backup upload failed');
  }
}
