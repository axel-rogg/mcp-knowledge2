#!/usr/bin/env tsx
/**
 * Restore an encrypted backup written by `src/crons/backup.ts`.
 *
 * Mirrors the encrypt path exactly:
 *   - AAD = "backup|<ts>" where <ts> is parsed from the object key
 *   - Format = serializeBlob([version: u8][nonce_len: u8][nonce][ciphertext])
 *   - Key   = BACKUP_MASTER_KEY (base64 or hex, decoded to 32 raw bytes)
 *
 * Usage:
 *   tsx scripts/restore-backup.ts <s3-key> [out-file]
 *
 * Examples:
 *   tsx scripts/restore-backup.ts backup/2026-05-17T03-00-00-000Z.dump.enc
 *   tsx scripts/restore-backup.ts backup/2026-05-17T03-00-00-000Z.dump.enc ./restore.dump
 *
 * After the script writes the decrypted .dump file:
 *   pg_restore --dbname=<target> --clean --no-owner --no-acl ./restore.dump
 *
 * Required env (read from process.env, NOT loadEnv — script must be
 * usable on a recovery machine without the full service env wired up):
 *   BACKUP_MASTER_KEY  — same value as in Doppler `privat`
 *   BLOB_ENDPOINT      — e.g. https://fly.storage.tigris.dev
 *   BLOB_REGION        — e.g. auto / eu-central / europe-west4
 *   BLOB_ACCESS_KEY    — S3 access key id
 *   BLOB_SECRET_KEY    — S3 secret access key
 *   BLOB_BUCKET        — fallback bucket if BACKUP_BUCKET unset
 * Optional:
 *   BACKUP_BUCKET      — bucket the encrypted dumps live in (default: BLOB_BUCKET)
 *   BLOB_PATH_STYLE    — 'true'/'false', default 'true'
 *
 * Fast way to pull all of these from Doppler in one shot:
 *   doppler run --project mcp-knowledge2 --config fly -- \
 *     tsx scripts/restore-backup.ts <s3-key>
 */

import { writeFile } from 'node:fs/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { decodeKey } from '../src/types/env.ts';
import { decrypt, importKey } from '../src/lib/crypto/aes_gcm.ts';
import { deserializeBlob } from '../src/lib/crypto/serialize.ts';

function die(msg: string): never {
  console.error(`[restore] ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) die(`${name} not set in environment`);
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0] === '-h' || args[0] === '--help') {
    console.error(
      'Usage: tsx scripts/restore-backup.ts <s3-key> [out-file]\n' +
        '  <s3-key>     e.g. backup/2026-05-17T03-00-00-000Z.dump.enc\n' +
        '  [out-file]   default: ./<basename-without-.enc>',
    );
    process.exit(2);
  }
  const key = args[0]!;
  if (!key.startsWith('backup/') || !key.endsWith('.dump.enc')) {
    die(`unexpected key shape: ${key} (expected backup/<ts>.dump.enc)`);
  }
  // ts is the filename between "backup/" and ".dump.enc"
  const ts = key.slice('backup/'.length, -'.dump.enc'.length);
  if (ts.length === 0) die(`could not parse timestamp from key: ${key}`);

  const outFile = args[1] ?? `./${ts}.dump`;

  // Resolve BACKUP_MASTER_KEY → 32 raw bytes
  const masterKeyStr = requireEnv('BACKUP_MASTER_KEY');
  const decoded = decodeKey(masterKeyStr);
  if (!decoded || decoded.length !== 32) {
    die(
      `BACKUP_MASTER_KEY decode failed (length=${decoded?.length ?? 0}, ` +
        'expected 32 raw bytes from base64 or hex)',
    );
  }

  const bucket = process.env.BACKUP_BUCKET ?? requireEnv('BLOB_BUCKET');
  const client = new S3Client({
    region: requireEnv('BLOB_REGION'),
    endpoint: requireEnv('BLOB_ENDPOINT'),
    forcePathStyle: (process.env.BLOB_PATH_STYLE ?? 'true') === 'true',
    credentials: {
      accessKeyId: requireEnv('BLOB_ACCESS_KEY'),
      secretAccessKey: requireEnv('BLOB_SECRET_KEY'),
    },
  });

  console.error(`[restore] downloading s3://${bucket}/${key}`);
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) die('S3 response had no Body');
  const blobBytes = new Uint8Array(await resp.Body.transformToByteArray());
  console.error(`[restore]   encrypted_bytes=${blobBytes.length}`);

  const blob = deserializeBlob(blobBytes);
  console.error(
    `[restore]   version=${blob.version} nonce_len=${blob.nonce.length} ` +
      `ciphertext_len=${blob.ciphertext.length}`,
  );

  const cryptoKey = await importKey(new Uint8Array(decoded));
  const aad = new TextEncoder().encode(`backup|${ts}`);

  let plaintext: Uint8Array;
  try {
    plaintext = await decrypt(cryptoKey, blob, aad);
  } catch (e) {
    die(
      `decrypt failed: ${(e as Error).message}. ` +
        'Possible causes: wrong BACKUP_MASTER_KEY, tampered ciphertext, or ' +
        'AAD-mismatch (object key renamed after upload).',
    );
  }

  await writeFile(outFile, plaintext);
  console.error(`[restore] wrote ${plaintext.length} plaintext bytes to ${outFile}`);
  console.error('[restore] done. Next step:');
  console.error(`           pg_restore --dbname=<target> --clean --no-owner --no-acl ${outFile}`);
}

main().catch((e) => {
  console.error('[restore] fatal:', e);
  process.exit(1);
});
