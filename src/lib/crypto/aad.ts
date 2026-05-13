// AAD (Additional Authenticated Data) builder — see PLAN-architecture-v2 §3.5.
//
//   AAD = '<recordType>|<owner_id>|<object_id>|<kind>:<subtype>'
//
// Binding the owner_id + object_id into the AAD prevents cross-user / cross-
// object ciphertext replay even if a row is moved between users (owner-
// transfer requires explicit re-encryption).

import type { ObjectKind } from '../../types/domain.ts';

export type RecordType =
  | 'objects'
  // 'objects-desc' was removed alongside migration 0003. description is
  // plaintext-only; nothing AAD-binds it.
  | 'objects-quality'
  | 'object-revisions';

export interface AadFields {
  recordType: RecordType;
  ownerId: string;
  objectId: string;
  kind: ObjectKind;
  subtype: string | null | undefined;
}

export function buildAad(f: AadFields): Uint8Array {
  const parts = [f.recordType, f.ownerId, f.objectId, `${f.kind}:${f.subtype ?? ''}`];
  return new TextEncoder().encode(parts.join('|'));
}
