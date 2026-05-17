// AAD (Additional Authenticated Data) builder — see PLAN-architecture-v2 §3.5.
//
//   AAD = '<recordType>|<owner_id>|<object_id>'
//
// Binding the owner_id + object_id into the AAD prevents cross-user / cross-
// object ciphertext replay even if a row is moved between users (owner-
// transfer requires explicit re-encryption).
//
// ADR-0004 (2026-05-15): The kind/subtype slot was removed from AAD as part
// of the generic-object-model refactor. subtype is free-form caller-convention
// without storage semantics; owner_id+object_id identify the ciphertext slot
// uniquely. This is a HARD-CUTOVER format change — existing ciphertexts no
// longer decrypt. Pre-pilot, no data was migrated.

export type RecordType =
  | 'objects'
  // 'objects-desc' was removed alongside migration 0003. description is
  // plaintext-only; nothing AAD-binds it.
  | 'objects-quality'
  | 'object-revisions'
  // SEC-K-029: idempotency-Cipher hatte recordType='object-revisions' als
  // "closest neutral" reused — Cross-AAD-Slot wenn jemand mal die objectId-
  // Invariante in middleware lockert. Dediziertes recordType eliminiert die
  // Drift. Alte idempotency-Records werden via TTL-Sweep aged-out.
  | 'idempotency';

export interface AadFields {
  recordType: RecordType;
  ownerId: string;
  objectId: string;
}

export function buildAad(f: AadFields): Uint8Array {
  return new TextEncoder().encode([f.recordType, f.ownerId, f.objectId].join('|'));
}
