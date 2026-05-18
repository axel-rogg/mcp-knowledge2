// AAD (Additional Authenticated Data) builder — see PLAN-architecture-v2 §3.5.
//
// Format-Varianten (Phase 1 sharing introduced 'objects-v2' + 'object-revisions-v2'):
//
//   Legacy (dek_scheme='owner_hkdf'):
//     AAD = '<recordType>|<owner_id>|<object_id>'
//
//   Phase 1 v2 (dek_scheme='per_object'):
//     AAD = '<recordType>|<object_id>'   (kein owner_id)
//
// Binding für legacy: owner_id + object_id verhindern cross-user/cross-object
// ciphertext-replay; owner-transfer braucht explizite Re-Encryption.
//
// Binding für v2: object_id allein bindet den Slot. Per-Object-DEK ist random
// (nicht owner-derived), also cross-user-Replay-Schutz kommt aus dem DEK-Wrap-
// Pfad (object_dek wrapped pro Group-Master bzw. owner_wrapped_dek), nicht aus
// AAD. owner-transfer ist mit v2 ohne Re-Encrypt möglich, cross-group-Sharing
// auch (ein Object-DEK, N wrapped_object_dek-Slots pro Group).
//
// **Domain-Separation:** der recordType im AAD-Präfix verhindert dass ein
// v1-Ciphertext in einem v2-Slot replayed wird (oder umgekehrt). Verifiziert
// in tests/unit/crypto.test.ts.
//
// ADR-0004 (2026-05-15): kind/subtype-Slot wurde aus AAD entfernt (generic-
// object-model refactor). subtype ist free-form caller-convention ohne
// storage-semantics.
//
// PLAN-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §3
// Crypto-Review-Ref: docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md §5

export type AadFields =
  // Legacy-Varianten (dek_scheme='owner_hkdf', owner-DEK + ownerId-AAD-bound)
  | { recordType: 'objects'; ownerId: string; objectId: string }
  | { recordType: 'objects-quality'; ownerId: string; objectId: string }
  | { recordType: 'object-revisions'; ownerId: string; objectId: string }
  // SEC-K-029: idempotency-Cipher hatte recordType='object-revisions' als
  // "closest neutral" reused — Cross-AAD-Slot wenn jemand mal die objectId-
  // Invariante in middleware lockert. Dediziertes recordType eliminiert die
  // Drift. Alte idempotency-Records werden via TTL-Sweep aged-out.
  | { recordType: 'idempotency'; ownerId: string; objectId: string }
  // Phase 1 v2-Varianten (dek_scheme='per_object', per-Object-DEK, KEIN ownerId)
  | { recordType: 'objects-v2'; objectId: string }
  | { recordType: 'object-revisions-v2'; objectId: string };

export type RecordType = AadFields['recordType'];

export function buildAad(f: AadFields): Uint8Array {
  // v2-Varianten haben kein ownerId-Feld. Discriminator über recordType-Suffix.
  // Wir nutzen typesafes Pattern-Matching statt 'in'-Check damit TypeScript
  // den Compiler-Error wirft wenn neue Varianten dazukommen.
  let serialized: string;
  switch (f.recordType) {
    case 'objects-v2':
    case 'object-revisions-v2':
      serialized = `${f.recordType}|${f.objectId}`;
      break;
    case 'objects':
    case 'objects-quality':
    case 'object-revisions':
    case 'idempotency':
      serialized = `${f.recordType}|${f.ownerId}|${f.objectId}`;
      break;
  }
  return new TextEncoder().encode(serialized);
}
