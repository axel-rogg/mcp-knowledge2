// Lazy-Migration owner_hkdf → per_object (Phase 1 sharing).
//
// PLAN-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §4
// Crypto-Review-Ref: CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md §3.2
//
// Wird beim ersten Share eines Objects mit einer Gruppe aufgerufen.
// Sequenz (innerhalb einer Postgres-TX, Caller MUSS FOR UPDATE auf objects-
// Row halten):
//   1. Object-Row laden (dek_scheme prüfen — wenn schon per_object: skip)
//   2. Body laden (inline oder R2)
//   3. Decrypt mit Owner-DEK + legacy AAD
//   4. Random 32B Per-Object-DEK generieren
//   5. Re-encrypt mit Per-Object-DEK + AAD-v2
//   6. Wrap Per-Object-DEK mit Owner-KEK → owner_wrapped_dek
//   7. R2-Put des neuen ciphertext (falls blob) ODER inline-update
//   8. UPDATE objects SET dek_scheme='per_object', owner_wrapped_dek=...,
//      body_inline OR blob_key=neu, nonce=..., key_version=...
//   9. Returnt Per-Object-DEK + Object-Row für Caller (für share_grants-Insert)
//
// Caller-Verantwortung: in derselben TX die share_grants-Rows inserten
// (wrapped_object_dek = wrapPerObjectDekForGroup(perObjectDek, groupMaster)).

import { eq } from 'drizzle-orm';
import { objects, type ObjectRow } from '../db/schema.ts';
import { type Db } from '../db/client.ts';
import { buildAad } from '../lib/crypto/aad.ts';
import { decrypt, encrypt, importKey } from '../lib/crypto/aes_gcm.ts';
import { kms } from '../adapters/kms/index.ts';
import { blobStore } from '../adapters/blob/index.ts';
import { errInternal } from '../lib/errors.ts';
import {
  generatePerObjectDek,
  unwrapPerObjectDekForOwner,
  wrapPerObjectDekForOwner,
} from './group-crypto.ts';

async function sha256Hex(input: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
  return Buffer.from(h).toString('hex');
}

const INLINE_BODY_MAX = 16 * 1024;
const R2_PREFIX = 'objects/';

export interface LazyMigrationResult {
  /** Plaintext Per-Object-DEK — Caller nutzt es um share_grants.wrapped_object_dek zu erzeugen */
  readonly perObjectDek: Uint8Array;
  /** Aktueller objects-Row nach Migration (dek_scheme='per_object') */
  readonly row: ObjectRow;
}

/**
 * Migriert ein Object von dek_scheme='owner_hkdf' zu 'per_object'.
 *
 * **Voraussetzungen Caller:**
 * - `db` ist eine RLS-scoped TX (`withUserTx`) als Owner.
 * - Object-Row wurde mit `FOR UPDATE` gelockt (Coordinator-Lock).
 * - Object-Row ist bereits geladen + Owner == current user verifiziert.
 *
 * **Idempotent:** Wenn `row.dekScheme === 'per_object'` schon, returnt
 * direkt das vorhandene unwrapped per-object-DEK (Caller braucht es eh
 * für den neuen Share).
 *
 * @param db scoped DB-TX (Owner-Identity)
 * @param row Object-Row (vor lock-update geladen)
 * @param requestId für KMS-Audit-Trail
 */
export async function lazyMigrateToPerObject(
  db: Db,
  row: ObjectRow,
  requestId: string,
): Promise<LazyMigrationResult> {
  // Idempotenz: wenn schon per_object, nur DEK unwrappen und zurückgeben
  if (row.dekScheme === 'per_object') {
    if (!row.ownerWrappedDek) {
      throw errInternal(
        `object ${row.id} is dek_scheme='per_object' but owner_wrapped_dek is NULL`,
      );
    }
    const ownerKek = await kms().resolveUserDek(row.ownerId, requestId);
    const perObjectDek = await unwrapPerObjectDekForOwner(
      row.ownerWrappedDek,
      ownerKek,
      row.ownerId,
      row.id,
    );
    return { perObjectDek, row };
  }

  if (row.dekScheme !== 'owner_hkdf') {
    throw errInternal(
      `lazyMigrateToPerObject: unknown dek_scheme '${row.dekScheme}' on object ${row.id}`,
    );
  }

  // 1. Decrypt body mit Owner-DEK + legacy AAD
  const ownerKek = await kms().resolveUserDek(row.ownerId, requestId);
  const oldKey = await importKey(ownerKek);
  const oldAad = buildAad({
    recordType: 'objects',
    ownerId: row.ownerId,
    objectId: row.id,
  });

  let oldCipher: Uint8Array;
  if (row.bodyInline) {
    oldCipher = row.bodyInline;
  } else if (row.blobKey) {
    const fromBlob = await blobStore().get(row.blobKey);
    if (!fromBlob) {
      throw errInternal(`lazyMigrate: blob ${row.blobKey} missing for object ${row.id}`);
    }
    oldCipher = fromBlob;
  } else {
    throw errInternal(`lazyMigrate: object ${row.id} has neither inline body nor blob_key`);
  }

  const plain = await decrypt(
    oldKey,
    { ciphertext: oldCipher, nonce: row.nonce, version: row.keyVersion },
    oldAad,
  );

  // 2. Random Per-Object-DEK
  const perObjectDek = generatePerObjectDek();

  // 3. Re-encrypt mit Per-Object-DEK + AAD-v2
  const newKey = await importKey(perObjectDek);
  const newAad = buildAad({ recordType: 'objects-v2', objectId: row.id });
  const newCipher = await encrypt(newKey, plain, newAad);
  const newBodyHash = await sha256Hex(plain);

  // 4. Wrap Per-Object-DEK mit Owner-KEK
  const ownerWrappedDek = await wrapPerObjectDekForOwner(
    perObjectDek,
    ownerKek,
    row.ownerId,
    row.id,
  );

  // 5. R2-Put oder inline-Update
  let newBodyInline: Uint8Array | null = null;
  let newBlobKey: string | null = null;
  if (newCipher.ciphertext.length <= INLINE_BODY_MAX) {
    newBodyInline = newCipher.ciphertext;
    // Wenn vorher in R2 war: alten Blob nicht löschen (Cron räumt nach
    // currentVersion-Stabilität). Sicher weil mit altem AAD verschlüsselt.
  } else {
    newBlobKey = row.blobKey ?? `${R2_PREFIX}${row.id}`;
    // **Wichtig:** R2-Put VOR DB-COMMIT. Wenn TX rollbacked, ist der
    // alte ciphertext im blob noch immer mit altem AAD verschlüsselt —
    // der überschriebene Inhalt ist mit Per-Object-DEK verschlüsselt,
    // der nicht in der DB persistiert wurde (rollbacked). Object würde
    // un-decryptable. Schöner Pfad: cron mit "old + new"-Blob-Keys
    // (Future-Work, Phase 1 akzeptiert das Restrisiko bei R2-Put-Crash).
    await blobStore().put(newBlobKey, newCipher.ciphertext, {
      contentType: 'application/octet-stream',
    });
  }

  // 6. UPDATE objects-Row
  const updated = await db
    .update(objects)
    .set({
      dekScheme: 'per_object',
      ownerWrappedDek,
      ownerWrapKeyVersion: 1, // Phase 1: einzelne owner-KEK-Version
      bodyInline: newBodyInline,
      blobKey: newBlobKey,
      nonce: newCipher.nonce,
      keyVersion: newCipher.version,
      bodyHash: newBodyHash,
      updatedAt: Date.now(),
    })
    .where(eq(objects.id, row.id))
    .returning();

  const newRow = updated[0];
  if (!newRow) {
    throw errInternal(`lazyMigrate: UPDATE objects returned no row for ${row.id}`);
  }

  return { perObjectDek, row: newRow };
}
