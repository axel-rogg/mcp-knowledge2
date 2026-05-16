// pg-boss cron scheduler. Bootstrapped at server startup.
//
// Jobs handle their own admin-tx (BYPASSRLS) because they operate
// across users — no `app.current_user` is set.

import PgBoss from 'pg-boss';
import { loadEnv } from '../types/env.ts';
import { logger } from '../lib/logger.ts';
import { sweepExpiredUploads, purgeExpiredUploads, cleanupOrphanBlobs } from './sweep.ts';
import { gcIdempotency } from './idempotency_gc.ts';
import { runBackup } from './backup.ts';

let bossInstance: PgBoss | null = null;

export async function startCrons(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const env = loadEnv();
  bossInstance = new PgBoss({
    connectionString: env.DATABASE_ADMIN_URL, // BYPASSRLS — needed for cross-user job state
    schema: 'pgboss',
    monitorStateIntervalSeconds: 30,
    retryLimit: 3,
    retryDelay: 60,
    deleteAfterDays: 30,
  });
  await bossInstance.start();
  logger.info('pg-boss started');

  // pg-boss v10+ entfernt implicit-queue-creation aus work()/schedule().
  // createQueue ist idempotent (no-op wenn schon existiert).
  const queues = [
    'uploads.sweep_expired',
    'uploads.purge_expired',
    'idempotency.gc',
    'backup.daily',
    'blobs.cleanup_orphans',
  ];
  for (const q of queues) {
    await bossInstance.createQueue(q);
  }

  await bossInstance.work('uploads.sweep_expired', sweepExpiredUploads);
  await bossInstance.work('uploads.purge_expired', purgeExpiredUploads);
  await bossInstance.work('idempotency.gc', gcIdempotency);
  await bossInstance.work('backup.daily', runBackup);
  await bossInstance.work('blobs.cleanup_orphans', cleanupOrphanBlobs);

  // Schedule
  await bossInstance.schedule('uploads.sweep_expired', '*/30 * * * *');
  await bossInstance.schedule('uploads.purge_expired', '0 * * * *');
  await bossInstance.schedule('idempotency.gc', '0 * * * *');
  await bossInstance.schedule('backup.daily', '0 3 * * *');
  await bossInstance.schedule('blobs.cleanup_orphans', '0 6 * * 0');

  logger.info('cron schedules registered');
  return bossInstance;
}

export async function stopCrons(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, timeout: 10_000 });
    bossInstance = null;
  }
}
