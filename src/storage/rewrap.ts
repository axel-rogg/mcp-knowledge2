// P2-7: Async Re-Wrap-Worker fuer groups mit >1000 share_grants.
//
// Producer: storage/groups.ts removeMember bei grant_count > 1000 enqueued
// einen rewrap_jobs-Eintrag mit KMS-wrapped Old-Master + new master_version.
// Member-Remove-TX rotiert dann nur Master + group_members; share_grants
// werden hier vom Worker prozessiert.
//
// Sicherheit: Plaintext-Old-Master wird NUR im Worker-Memory unwrap'd
// (KMS-Decrypt aus rewrap_jobs.old_master_kms_wrapped), nach Job-Completion
// wird die DB-Spalte auf empty-bytes gesetzt + status='completed'.
//
// Failure-Modi:
//   - Worker crash mid-batch → status bleibt 'running'. Naechster Tick
//     nimmt Job wieder auf, skipped grants die schon group_master_version
//     >= new_master_version haben (Idempotenz-Schutz).
//   - KMS-Decrypt failt → status='failed', last_error gespeichert.
//
// Worker laeuft per Operator-Tick (POST /v1/internal/rewrap-tick) oder
// optional setInterval beim Boot wenn REWRAP_WORKER_ENABLED=on.

import { and, eq, lt, sql } from 'drizzle-orm';
import { rewrapJobs, shareGrants } from '../db/schema.ts';
import { withAdminTx } from '../db/client.ts';
import { kms } from '../adapters/kms/index.ts';
import {
  unwrapPerObjectDekFromGroup,
  wrapPerObjectDekForGroup,
} from './group-crypto.ts';
import { nowMs } from '../lib/ids.ts';

export interface RewrapJobView {
  readonly id: string;
  readonly groupId: string;
  readonly oldMasterVersion: number;
  readonly newMasterVersion: number;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly totalGrants: number;
  readonly processedGrants: number;
  readonly batchSize: number;
  readonly triggerReason: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly lastError: string | null;
}

export interface ProcessTickResult {
  readonly picked: number;
  readonly processedGrants: number;
  readonly completedJobs: number;
  readonly errors: ReadonlyArray<{ jobId: string; error: string }>;
}

/**
 * Tickt einmal: picked bis `maxJobs` pending/running Jobs, prozessiert
 * bis `batchSize` Grants pro Job. Pro Job laeuft eine Admin-TX.
 *
 * Operator triggert via cron oder POST /v1/internal/rewrap-tick.
 * Empfohlene Cadenz: alle 30s.
 */
export async function processRewrapJobsTick(
  opts: { readonly maxJobs?: number; readonly batchSize?: number } = {},
): Promise<ProcessTickResult> {
  const maxJobs = opts.maxJobs ?? 5;
  const batchSize = opts.batchSize ?? 100;
  const errors: Array<{ jobId: string; error: string }> = [];
  let processedGrants = 0;
  let completedJobs = 0;

  // Pick pending/running jobs (oldest first).
  const pending = await withAdminTx(async (db) =>
    db
      .select()
      .from(rewrapJobs)
      .where(sql`${rewrapJobs.status} IN ('pending', 'running')`)
      .orderBy(rewrapJobs.createdAt)
      .limit(maxJobs),
  );

  for (const job of pending) {
    try {
      const result = await processOneJob(job.id, job.groupId, job.newMasterVersion, batchSize);
      processedGrants += result.processedInTick;
      if (result.completed) completedJobs += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ jobId: job.id, error: msg });
      await withAdminTx(async (db) => {
        await db
          .update(rewrapJobs)
          .set({ status: 'failed', lastError: msg })
          .where(eq(rewrapJobs.id, job.id));
      });
    }
  }

  return { picked: pending.length, processedGrants, completedJobs, errors };
}

interface OneJobResult {
  readonly processedInTick: number;
  readonly completed: boolean;
}

async function processOneJob(
  jobId: string,
  groupId: string,
  newMasterVersion: number,
  batchSize: number,
): Promise<OneJobResult> {
  return withAdminTx(async (db) => {
    // Re-load Job + mark running (idempotent for started_at).
    const jobRows = await db.select().from(rewrapJobs).where(eq(rewrapJobs.id, jobId)).limit(1);
    const job = jobRows[0];
    if (!job) throw new Error(`job ${jobId} disappeared`);
    if (job.status === 'completed') return { processedInTick: 0, completed: true };

    await db
      .update(rewrapJobs)
      .set({
        status: 'running',
        startedAt: sql`COALESCE(${rewrapJobs.startedAt}, ${nowMs()})`,
      })
      .where(eq(rewrapJobs.id, jobId));

    // Unwrap OLD-Master mit KMS
    const oldMaster = await kms().unwrapBytes(job.oldMasterKmsWrapped);

    // Fetch new master via groups.wrapped_master_dek + KMS unwrap.
    const groupRows = await db.execute<{ wrapped_master_dek: Buffer; master_version: number }>(
      sql`SELECT wrapped_master_dek, master_version FROM groups WHERE id = ${groupId}`,
    );
    const arr = groupRows as unknown as Array<{ wrapped_master_dek: Buffer; master_version: number }>;
    const groupRow = arr[0];
    if (!groupRow) throw new Error(`group ${groupId} not found`);
    const newMaster = await kms().unwrapBytes(new Uint8Array(groupRow.wrapped_master_dek));

    // Batch von ausstehenden grants (Idempotenz-Filter: group_master_version < newVersion)
    const batch = await db
      .select()
      .from(shareGrants)
      .where(
        and(
          eq(shareGrants.grantedToGroupId, groupId),
          lt(shareGrants.groupMasterVersion, newMasterVersion),
        ),
      )
      .limit(batchSize);

    let processedInBatch = 0;
    for (const g of batch) {
      if (!g.wrappedObjectDek) continue;
      const objectDek = await unwrapPerObjectDekFromGroup(g.wrappedObjectDek, oldMaster, g.resourceId);
      const newWrappedObjectDek = await wrapPerObjectDekForGroup(objectDek, newMaster, g.resourceId);
      await db
        .update(shareGrants)
        .set({ wrappedObjectDek: newWrappedObjectDek, groupMasterVersion: newMasterVersion })
        .where(eq(shareGrants.id, g.id));
      processedInBatch += 1;
    }

    const newProcessed = job.processedGrants + processedInBatch;
    const isComplete = batch.length < batchSize || newProcessed >= job.totalGrants;

    if (isComplete) {
      await db
        .update(rewrapJobs)
        .set({
          status: 'completed',
          processedGrants: newProcessed,
          completedAt: nowMs(),
          // Wipe encrypted old-master snapshot (defense in depth)
          oldMasterKmsWrapped: new Uint8Array(0),
        })
        .where(eq(rewrapJobs.id, jobId));
      return { processedInTick: processedInBatch, completed: true };
    }

    await db
      .update(rewrapJobs)
      .set({ processedGrants: newProcessed })
      .where(eq(rewrapJobs.id, jobId));
    return { processedInTick: processedInBatch, completed: false };
  });
}

/**
 * Read-only Liste pending Jobs fuer Operator-Diagnose.
 */
export async function listRewrapJobs(
  opts: { readonly groupId?: string; readonly status?: string; readonly limit?: number } = {},
): Promise<RewrapJobView[]> {
  return withAdminTx(async (db) => {
    const conditions = [] as Array<ReturnType<typeof eq>>;
    if (opts.groupId !== undefined) conditions.push(eq(rewrapJobs.groupId, opts.groupId));
    if (opts.status !== undefined) conditions.push(eq(rewrapJobs.status, opts.status));
    let qb = db.select().from(rewrapJobs).$dynamic();
    if (conditions.length > 0) qb = qb.where(and(...conditions));
    const rows = await qb.orderBy(rewrapJobs.createdAt).limit(opts.limit ?? 50);
    return rows.map((r) => ({
      id: r.id,
      groupId: r.groupId,
      oldMasterVersion: r.oldMasterVersion,
      newMasterVersion: r.newMasterVersion,
      status: r.status as 'pending' | 'running' | 'completed' | 'failed',
      totalGrants: r.totalGrants,
      processedGrants: r.processedGrants,
      batchSize: r.batchSize,
      triggerReason: r.triggerReason,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      lastError: r.lastError,
    }));
  });
}
