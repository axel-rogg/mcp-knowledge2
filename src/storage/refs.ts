// Knowledge-graph refs between objects. RLS on object_refs delegates to
// objects visibility (see migrations/0001_rls.sql).

import { and, eq, or, sql } from 'drizzle-orm';
import { objectRefs, objects } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest, errNotFound } from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';

export interface AddRefInput {
  fromId: string;
  toId: string;
  role: string;
  meta?: Record<string, unknown> | null;
}

export async function addRef(input: AddRefInput): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');

  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // verify both ends visible under RLS
    const visible = await db
      .select({ id: objects.id })
      .from(objects)
      .where(or(eq(objects.id, input.fromId), eq(objects.id, input.toId)));
    if (visible.length < 2) {
      throw errNotFound('one or both objects not found or not visible');
    }
    const inserted = await db
      .insert(objectRefs)
      .values({
        fromId: input.fromId,
        toId: input.toId,
        role: input.role,
        metaJson: input.meta ?? null,
        createdAt: nowMs(),
      })
      .onConflictDoNothing()
      .returning({ fromId: objectRefs.fromId });

    // refcount snapshot on `to` — only increment if a new row was inserted
    if (inserted.length > 0) {
      await db
        .update(objects)
        .set({ refcount: sql`${objects.refcount} + 1` })
        .where(eq(objects.id, input.toId));
    }
  });
}

export async function removeRef(fromId: string, toId: string, role: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const deleted = await db
      .delete(objectRefs)
      .where(
        and(eq(objectRefs.fromId, fromId), eq(objectRefs.toId, toId), eq(objectRefs.role, role)),
      )
      .returning({ fromId: objectRefs.fromId });
    if (deleted.length > 0) {
      await db
        .update(objects)
        .set({ refcount: sql`GREATEST(${objects.refcount} - 1, 0)` })
        .where(eq(objects.id, toId));
    }
  });
}

export interface RefRow {
  fromId: string;
  toId: string;
  role: string;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export async function listOutgoingRefs(fromId: string): Promise<RefRow[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db.select().from(objectRefs).where(eq(objectRefs.fromId, fromId));
    return r.map((row) => ({
      fromId: row.fromId,
      toId: row.toId,
      role: row.role,
      meta: row.metaJson as Record<string, unknown> | null,
      createdAt: row.createdAt,
    }));
  });
}

export async function listIncomingRefs(toId: string): Promise<RefRow[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db.select().from(objectRefs).where(eq(objectRefs.toId, toId));
    return r.map((row) => ({
      fromId: row.fromId,
      toId: row.toId,
      role: row.role,
      meta: row.metaJson as Record<string, unknown> | null,
      createdAt: row.createdAt,
    }));
  });
}
