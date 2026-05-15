import { Hono } from 'hono';
import { z } from 'zod';
import { hybridSearch } from '../search/hybrid.ts';
import { assertEmbedQuota } from '../quota/check.ts';
import { requireContext } from '../lib/context.ts';
import { emitAudit } from '../observability/audit.ts';
import { errBadRequest } from '../lib/errors.ts';

const SearchBody = z.object({
  query: z.string().min(1).max(2000),
  subtypes: z.array(z.string().min(1).max(32)).max(16).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export const searchRouter = new Hono().post('/search', async (c) => {
  const b = SearchBody.parse(await c.req.json());
  const ctx = requireContext();
  if (!ctx.userId) throw errBadRequest('user context required');
  // Search uses an embedding call → quota
  await assertEmbedQuota(ctx.userId, ctx.requestId);

  const hits = await hybridSearch({
    query: b.query,
    ...(b.subtypes !== undefined ? { subtypes: b.subtypes } : {}),
    ...(b.limit !== undefined ? { limit: b.limit } : {}),
  });
  // NEVER include the query in audit details — search-privacy (PLAN §5.4)
  await emitAudit({ action: 'search.hybrid', result: 'success', details: { result_count: hits.length } });
  return c.json({ items: hits });
});
