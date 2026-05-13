// UUID v4 generator (PLAN-decision). ULID is *not* used in v2 — object IDs are
// UUIDs to match the v1 schema choice. ULIDs are kept available for any non-
// persistent correlation identifiers if needed (e.g., job ids), via ulidx.

import { webcrypto } from 'node:crypto';
import { ulid as ulidGen } from 'ulidx';

export function uuidV4(): string {
  return webcrypto.randomUUID();
}

export function ulid(): string {
  return ulidGen();
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function nowMs(): number {
  return Date.now();
}
