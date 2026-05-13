import { and, eq } from 'drizzle-orm';
import { objectTags } from '../db/schema.ts';
import { withUserTx } from '../db/client.ts';
import { requireContext } from '../lib/context.ts';
import { errBadRequest } from '../lib/errors.ts';
import { nowMs } from '../lib/ids.ts';

export async function addTag(objectId: string, tag: string, source = 'manual'): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    await db
      .insert(objectTags)
      .values({ objectId, tag, source, createdAt: nowMs() })
      .onConflictDoNothing();
  });
}

export async function removeTag(objectId: string, tag: string): Promise<void> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    await db.delete(objectTags).where(and(eq(objectTags.objectId, objectId), eq(objectTags.tag, tag)));
  });
}

export async function listTags(objectId: string): Promise<string[]> {
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    const r = await db
      .select({ tag: objectTags.tag })
      .from(objectTags)
      .where(eq(objectTags.objectId, objectId));
    return r.map((t) => t.tag);
  });
}
