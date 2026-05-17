// SEC-K-005 Step B: per-user dek_salt + version resolver.
//
// Migration 0015 hat `users.dek_salt BYTEA NOT NULL DEFAULT gen_random_bytes(32)`
// + `users.dek_salt_version INTEGER NOT NULL DEFAULT 1` angelegt. Dieses
// Modul ist die einzige Quelle die KMS-Adapter beide Felder bekommen damit
// HKDF die richtige Derivation-Variante waehlen kann:
//
//   v1 (legacy): salt = userId,            info = 'dek-v1'  (Migration 0015 Bestand)
//   v2 (current): salt = userId || dek_salt, info = 'dek-v2'
//
// Master-Key-Leak bei v1 erlaubt brute-derivation aller DEKs (userId ist
// public). v2 mixt 32 zufaellige Bytes pro User → Master-Leak alleine
// reicht nicht mehr, dek_salt muss aus der DB extrahiert sein.
//
// Cache-Strategie: kleine in-memory Map ohne TTL. Invalidation via
// invalidateDekState() vom Re-Encrypt-Script + Tests. dek_salt aendert
// sich praktisch nie (set bei User-Create, danach permanent solange Master
// gleich bleibt) → Cache-Misses minimal, Cache-Eviction nicht relevant.

import { eq } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { errNotFound } from '../lib/errors.ts';

export interface DekState {
  /** 32 random bytes pro User (DB-default gen_random_bytes(32), Migration 0015) */
  dekSalt: Uint8Array;
  /** 1 = legacy (salt=userId), 2 = current (salt=userId||dek_salt). */
  version: number;
}

const cache = new Map<string, DekState>();

export async function getDekState(userId: string): Promise<DekState> {
  const cached = cache.get(userId);
  if (cached) return cached;

  const state = await withAdminTx(async (db) => {
    const rows = await db
      .select({ dekSalt: users.dekSalt, dekSaltVersion: users.dekSaltVersion })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) throw errNotFound(`user ${userId} not found for dek-state resolve`);
    return {
      dekSalt: row.dekSalt,
      version: row.dekSaltVersion,
    };
  });

  cache.set(userId, state);
  return state;
}

/**
 * Drop the cached state for a specific user (or all users with no arg).
 * Called by the re-encrypt script after bumping `dek_salt_version` so
 * subsequent crypto-ops pick up v2 derivation. Also used by tests to
 * reset between cases.
 */
export function invalidateDekState(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
