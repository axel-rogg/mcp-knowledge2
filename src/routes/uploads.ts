import { Hono } from 'hono';
import { z } from 'zod';
import { finalizeUpload, getUploadStatus, initUpload } from '../storage/uploads.ts';
import { emitAudit } from '../observability/audit.ts';

const InitBody = z.object({
  content_type: z.string().max(256).optional(),
  meta: z.record(z.unknown()).optional(),
});

export const uploadsRouter = new Hono()
  .post('/uploads/init', async (c) => {
    const b = InitBody.parse(await c.req.json().catch(() => ({})));
    const out = await initUpload({
      ...(b.content_type !== undefined ? { contentType: b.content_type } : {}),
      ...(b.meta !== undefined ? { meta: b.meta } : {}),
    });
    await emitAudit({ action: 'upload.init', resourceId: out.uploadId, result: 'success' });
    return c.json({
      upload_id: out.uploadId,
      presigned_url: out.presignedUrl,
      expires_at: out.expiresAt,
    });
  })
  .post('/uploads/:id/finalize', async (c) => {
    const id = c.req.param('id');
    const status = await finalizeUpload(id);
    await emitAudit({ action: 'upload.finalize', resourceId: id, result: 'success' });
    return c.json(status);
  })
  .get('/uploads/:id/status', async (c) => {
    const id = c.req.param('id');
    return c.json(await getUploadStatus(id));
  });
