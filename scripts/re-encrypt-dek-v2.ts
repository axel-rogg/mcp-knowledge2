// SEC-K-005 Step B Re-Encrypt: für jeden User mit dek_salt_version=1 alle
// owned encrypted Bodies entschluesseln (alter DEK = HKDF(master, salt=userId,
// info='dek-v1')) und neu verschluesseln (neuer DEK = HKDF(master,
// salt=userId||dek_salt, info='dek-v2')). Anschliessend dek_salt_version=2
// setzen — danach sieht der Live-Service den User automatisch als v2 und
// resolveUserDek liefert den neuen DEK.
//
// Anwendungs-Pfad (Operator-Step):
//   $ DATABASE_ADMIN_URL=... KMS_PROVIDER=hkdf_local KMS_MASTER_KEY_B64=... \
//     tsx scripts/re-encrypt-dek-v2.ts
//
//   $ # oder dry-run zuerst:
//   $ DRY_RUN=1 tsx scripts/re-encrypt-dek-v2.ts
//
// Output: pro User die Anzahl re-encrypted rows. Errors → exit nicht-null,
// Operator muss aufraeumen (kann durch SQL ROLLBACK gemacht werden, das
// Script committed pro User in seiner eigenen tx).
//
// Idempotent: re-run trifft nur noch User die immer noch version=1 haben
// (entweder weil sie neu sind, oder weil ein vorheriger Run fehlerhaft
// rollback'ed hat).
//
// Was wird angefasst:
//   * objects.body_inline + R2-blob (key='objects/<id>') bei objects mit
//     blob_key NOT NULL
//   * object_revisions.body_inline + R2-blob (key='objects/<id>@v<n>')
//   * uploads sind status='finalized' R2-only mit blob_key='objects/<id>'
//     — werden ueber objects-Pfad miterfasst, kein extra Loop noetig
//   * idempotency_records: nicht angefasst, TTL=24h erledigt es selbst
//
// Was passiert wenn der Live-Service waehrend des Scripts laeuft:
//   Per-User-Transaction + dek_salt_version-Update-am-Ende. Solange die
//   Transaction offen ist sieht der Live-Service noch v1; nach Commit
//   gleichzeitig v2. Die in-memory Cache des Live-Service (dek_state.ts)
//   muss invalidiert werden — entweder via Restart oder via
//   invalidateDekState(userId) Endpoint (TODO future).
//   Fuer SOLO-PILOT (1 User, manueller Operator-Step): einfach den Service
//   stoppen, Re-Encrypt laufen lassen, Service wieder hochfahren.

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { decrypt, encrypt, importKey, randomBytes } from '../src/lib/crypto/aes_gcm.ts';
import { buildAad } from '../src/lib/crypto/aad.ts';

const hkdfAsync = promisify(hkdf);

interface UserRow {
  id: string;
  email: string;
  dek_salt: Buffer;
  dek_salt_version: number;
}

interface ObjectRow {
  id: string;
  owner_id: string;
  subtype: string | null;
  body_inline: Buffer | null;
  blob_key: string | null;
  nonce: Buffer;
  key_version: number;
}

interface RevisionRow {
  object_id: string;
  version: number;
  body_inline: Buffer | null;
  blob_key: string | null;
  nonce: Buffer | null;
}

function loadMasterKey(): Uint8Array {
  const provider = process.env.KMS_PROVIDER;
  if (provider !== 'hkdf_local') {
    throw new Error(
      `re-encrypt-script supports only KMS_PROVIDER=hkdf_local locally. Got: ${provider}. ` +
        `Fuer cloud_kms bitte das wrapped master vorab in KMS_MASTER_KEY_B64 dekrypten ` +
        `oder das Script erweitern.`,
    );
  }
  const raw = process.env.KMS_MASTER_KEY_B64;
  if (!raw) throw new Error('KMS_MASTER_KEY_B64 not set');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`KMS_MASTER_KEY_B64 must decode to 32 bytes, got ${buf.length}`);
  return new Uint8Array(buf);
}

async function deriveDek(
  master: Uint8Array,
  userId: string,
  version: number,
  dekSalt: Uint8Array,
): Promise<Uint8Array> {
  const userIdBytes = new TextEncoder().encode(userId);
  let saltInput: Uint8Array;
  let info: Uint8Array;
  if (version >= 2) {
    saltInput = new Uint8Array(userIdBytes.length + dekSalt.length);
    saltInput.set(userIdBytes, 0);
    saltInput.set(dekSalt, userIdBytes.length);
    info = new TextEncoder().encode('dek-v2');
  } else {
    saltInput = userIdBytes;
    info = new TextEncoder().encode('dek-v1');
  }
  const derived = await hkdfAsync('sha256', master, saltInput, info, 32);
  return new Uint8Array(derived as ArrayBuffer);
}

function s3Client(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }
  return new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

async function r2Get(client: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = resp.Body;
  if (!body) throw new Error(`R2 GET ${key}: no body`);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

async function r2Put(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function reencryptUser(
  client: pg.PoolClient,
  s3: S3Client | null,
  bucket: string | null,
  master: Uint8Array,
  user: UserRow,
  dryRun: boolean,
): Promise<{ objects: number; revisions: number; skipped: number }> {
  if (user.dek_salt_version !== 1) {
    return { objects: 0, revisions: 0, skipped: 0 };
  }
  const dekSalt = new Uint8Array(user.dek_salt);
  const oldDek = await deriveDek(master, user.id, 1, dekSalt);
  const newDek = await deriveDek(master, user.id, 2, dekSalt);
  const oldKey = await importKey(oldDek);
  const newKey = await importKey(newDek);

  await client.query('BEGIN');
  let objCount = 0;
  let revCount = 0;
  let skipped = 0;

  try {
    const objs = await client.query<ObjectRow>(
      `SELECT id, owner_id, subtype, body_inline, blob_key, nonce, key_version
       FROM objects WHERE owner_id = $1 AND deleted_at IS NULL`,
      [user.id],
    );
    for (const row of objs.rows) {
      const aad = buildAad({ recordType: 'objects', ownerId: row.owner_id, objectId: row.id });

      if (row.body_inline) {
        const plain = await decrypt(
          oldKey,
          {
            ciphertext: new Uint8Array(row.body_inline),
            nonce: new Uint8Array(row.nonce),
            version: row.key_version,
          },
          aad,
        );
        const newNonce = randomBytes(12);
        const reblob = await encrypt(newKey, plain, aad, row.key_version);
        if (!dryRun) {
          await client.query(
            `UPDATE objects SET body_inline = $1, nonce = $2 WHERE id = $3`,
            [Buffer.from(reblob.ciphertext), Buffer.from(newNonce), row.id],
          );
        }
        objCount += 1;
      } else if (row.blob_key) {
        if (!s3 || !bucket) {
          console.warn(`  ⚠ skip object ${row.id} (blob_key=${row.blob_key}): R2 not configured`);
          skipped += 1;
          continue;
        }
        const cipher = await r2Get(s3, bucket, row.blob_key);
        const plain = await decrypt(
          oldKey,
          {
            ciphertext: cipher,
            nonce: new Uint8Array(row.nonce),
            version: row.key_version,
          },
          aad,
        );
        const newNonce = randomBytes(12);
        const reblob = await encrypt(newKey, plain, aad, row.key_version);
        if (!dryRun) {
          await r2Put(s3, bucket, row.blob_key, reblob.ciphertext);
          await client.query(`UPDATE objects SET nonce = $1 WHERE id = $2`, [
            Buffer.from(newNonce),
            row.id,
          ]);
        }
        objCount += 1;
      }
    }

    const revs = await client.query<RevisionRow>(
      `SELECT r.object_id, r.version, r.body_inline, r.blob_key, r.nonce
       FROM object_revisions r
       JOIN objects o ON o.id = r.object_id
       WHERE o.owner_id = $1`,
      [user.id],
    );
    for (const rev of revs.rows) {
      if (!rev.nonce) {
        // version-0 plaintext / meta rows — nothing encrypted
        continue;
      }
      const aad = buildAad({
        recordType: 'object-revisions',
        ownerId: user.id,
        objectId: rev.object_id,
      });
      if (rev.body_inline) {
        const plain = await decrypt(
          oldKey,
          {
            ciphertext: new Uint8Array(rev.body_inline),
            nonce: new Uint8Array(rev.nonce),
            version: 1,
          },
          aad,
        );
        const newNonce = randomBytes(12);
        const reblob = await encrypt(newKey, plain, aad, 1);
        if (!dryRun) {
          await client.query(
            `UPDATE object_revisions SET body_inline = $1, nonce = $2
             WHERE object_id = $3 AND version = $4`,
            [Buffer.from(reblob.ciphertext), Buffer.from(newNonce), rev.object_id, rev.version],
          );
        }
        revCount += 1;
      } else if (rev.blob_key) {
        if (!s3 || !bucket) {
          console.warn(`  ⚠ skip revision ${rev.object_id}@${rev.version}: R2 not configured`);
          skipped += 1;
          continue;
        }
        const cipher = await r2Get(s3, bucket, rev.blob_key);
        const plain = await decrypt(
          oldKey,
          {
            ciphertext: cipher,
            nonce: new Uint8Array(rev.nonce),
            version: 1,
          },
          aad,
        );
        const newNonce = randomBytes(12);
        const reblob = await encrypt(newKey, plain, aad, 1);
        if (!dryRun) {
          await r2Put(s3, bucket, rev.blob_key, reblob.ciphertext);
          await client.query(
            `UPDATE object_revisions SET nonce = $1 WHERE object_id = $2 AND version = $3`,
            [Buffer.from(newNonce), rev.object_id, rev.version],
          );
        }
        revCount += 1;
      }
    }

    if (!dryRun) {
      await client.query(`UPDATE users SET dek_salt_version = 2 WHERE id = $1`, [user.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  return { objects: objCount, revisions: revCount, skipped };
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL must be set');
  const master = loadMasterKey();

  const r2Bucket = process.env.R2_BUCKET ?? null;
  const s3 = r2Bucket ? s3Client() : null;
  if (!s3) {
    console.warn(
      'ℹ R2_BUCKET not set — R2-stored blobs werden geskippt + gemeldet. ' +
        'Fuer ein vollstaendiges Re-Encrypt: R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY setzen.',
    );
  }

  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  console.log(`${dryRun ? '[DRY-RUN] ' : ''}re-encrypt-dek-v2 starting…`);

  try {
    const users = await client.query<UserRow>(
      `SELECT id, email, dek_salt, dek_salt_version FROM users WHERE dek_salt_version = 1`,
    );
    console.log(`  ${users.rows.length} user(s) at version=1 to migrate`);

    let totalObj = 0;
    let totalRev = 0;
    let totalSkipped = 0;
    for (const user of users.rows) {
      console.log(`  → ${user.email} (${user.id})`);
      const r = await reencryptUser(client, s3, r2Bucket, master, user, dryRun);
      console.log(
        `    objects=${r.objects} revisions=${r.revisions}` +
          (r.skipped > 0 ? ` skipped=${r.skipped}` : ''),
      );
      totalObj += r.objects;
      totalRev += r.revisions;
      totalSkipped += r.skipped;
    }

    console.log(
      `${dryRun ? '[DRY-RUN] ' : ''}done — objects=${totalObj} revisions=${totalRev}` +
        (totalSkipped > 0 ? ` skipped=${totalSkipped}` : ''),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('re-encrypt-dek-v2 failed:', err);
  process.exit(1);
});
