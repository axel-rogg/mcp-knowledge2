// Per-user quota enforcement (PLAN §11).
//
// Defaults: 10k objects / 5 GB / 1000 embed-calls/day / 30 QPS burst.

import { eq, sql } from 'drizzle-orm';
import { userQuotas, type UserQuotaRow } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { errQuotaExceeded } from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';

const DEFAULTS = {
  object_count_max: 10_000,
  storage_bytes_max: 5_368_709_120,
  embed_calls_per_day: 1_000,
  search_qps_burst: 30,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function ensureQuotaRow(userId: string, requestId: string): Promise<UserQuotaRow> {
  return await withUserTx(userId, requestId, async (db) => {
    const existing = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId)).limit(1);
    if (existing[0]) return existing[0];
    const now = nowMs();
    const inserted = await db
      .insert(userQuotas)
      .values({
        userId,
        objectCountMax: DEFAULTS.object_count_max,
        storageBytesMax: DEFAULTS.storage_bytes_max,
        embedCallsPerDay: DEFAULTS.embed_calls_per_day,
        searchQpsBurst: DEFAULTS.search_qps_burst,
        objectCountUsed: 0,
        storageBytesUsed: 0,
        embedCallsToday: 0,
        embedCallsResetAt: now + ONE_DAY_MS,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row) return row;
    // race: re-select
    const again = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId)).limit(1);
    if (!again[0]) throw new Error('quota row missing after insert race');
    return again[0];
  });
}

export interface ObjectQuotaCheck {
  bodySize: number;
}

export async function assertObjectQuota(
  userId: string,
  requestId: string,
  check: ObjectQuotaCheck,
): Promise<void> {
  const q = await ensureQuotaRow(userId, requestId);
  if (q.objectCountUsed + 1 > q.objectCountMax) {
    throw errQuotaExceeded('object count quota exceeded', {
      used: q.objectCountUsed,
      max: q.objectCountMax,
    });
  }
  if (q.storageBytesUsed + check.bodySize > q.storageBytesMax) {
    throw errQuotaExceeded('storage byte quota exceeded', {
      used: q.storageBytesUsed,
      max: q.storageBytesMax,
      attempted: check.bodySize,
    });
  }
  // increment optimistically
  await withUserTx(userId, requestId, async (db) => {
    await db
      .update(userQuotas)
      .set({
        objectCountUsed: sql`${userQuotas.objectCountUsed} + 1`,
        storageBytesUsed: sql`${userQuotas.storageBytesUsed} + ${check.bodySize}`,
        updatedAt: nowMs(),
      })
      .where(eq(userQuotas.userId, userId));
  });
}

export async function assertEmbedQuota(userId: string, requestId: string): Promise<void> {
  const q = await ensureQuotaRow(userId, requestId);
  const now = nowMs();

  if (now >= q.embedCallsResetAt) {
    // reset window
    await withUserTx(userId, requestId, async (db) => {
      await db
        .update(userQuotas)
        .set({
          embedCallsToday: 1,
          embedCallsResetAt: now + ONE_DAY_MS,
          updatedAt: now,
        })
        .where(eq(userQuotas.userId, userId));
    });
    return;
  }

  if (q.embedCallsToday + 1 > q.embedCallsPerDay) {
    throw errQuotaExceeded('embedding-call quota exceeded for today', {
      used: q.embedCallsToday,
      max: q.embedCallsPerDay,
      resetAt: q.embedCallsResetAt,
    });
  }

  await withUserTx(userId, requestId, async (db) => {
    await db
      .update(userQuotas)
      .set({
        embedCallsToday: sql`${userQuotas.embedCallsToday} + 1`,
        updatedAt: nowMs(),
      })
      .where(eq(userQuotas.userId, userId));
  });
}

export async function releaseObjectQuota(
  userId: string,
  requestId: string,
  bodySize: number,
): Promise<void> {
  await withUserTx(userId, requestId, async (db) => {
    await db
      .update(userQuotas)
      .set({
        objectCountUsed: sql`GREATEST(${userQuotas.objectCountUsed} - 1, 0)`,
        storageBytesUsed: sql`GREATEST(${userQuotas.storageBytesUsed} - ${bodySize}, 0)`,
        updatedAt: nowMs(),
      })
      .where(eq(userQuotas.userId, userId));
  });
}
