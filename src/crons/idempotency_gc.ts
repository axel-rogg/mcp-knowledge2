import { lt } from 'drizzle-orm';
import { withAdminTx } from '../db/client.ts';
import { idempotencyRecords } from '../db/schema.ts';
import { nowMs } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';

export async function gcIdempotency(): Promise<void> {
  const deleted = await withAdminTx(async (db) => {
    return db
      .delete(idempotencyRecords)
      .where(lt(idempotencyRecords.expiresAt, nowMs()))
      .returning({ idemKey: idempotencyRecords.idemKey });
  });
  if (deleted.length > 0) logger.info({ count: deleted.length }, 'idempotency gc');
}
