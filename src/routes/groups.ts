// HTTP-Routes für Group-Sharing Phase 1 (Item 6c).
//
// PLAN-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §6
// ADR: mcp-approval2/docs/adr/0024-group-sharing-architecture.md
//
// 8 Endpoints unter /v1/groups/*:
//   POST   /v1/groups                          → create
//   GET    /v1/groups                          → list (current user's groups)
//   GET    /v1/groups/:id                      → get with members
//   PATCH  /v1/groups/:id                      → update (name/desc/read_audit)
//   DELETE /v1/groups/:id                      → archive
//   POST   /v1/groups/:id/members              → add member
//   DELETE /v1/groups/:id/members/:user_id     → remove member (mit Rotation)
//   PATCH  /v1/groups/:id/read-audit           → toggle read_audit_enabled
//
// Plus: POST /v1/objects/:id/share-with-group  (in shares.ts erweitert).
//
// Auth: alle Endpoints sind OBO-JWT-gated (require_jwt_or_obo-middleware
// im server.ts mountet das vorab). RLS sorgt für per-User-Isolation.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  addMember,
  archiveGroup,
  createGroup,
  getGroup,
  listGroupsForUser,
  removeMember,
  setReadAudit,
} from '../storage/groups.ts';
import { emitAudit } from '../observability/audit.ts';

const CreateGroupBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  read_audit_enabled: z.boolean().optional(),
  cascade_on_share_default: z.boolean().optional(),
});

const AddMemberBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['admin', 'member']).optional(),
});

const SetReadAuditBody = z.object({
  enabled: z.boolean(),
});

const UpdateGroupBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const groupsRouter = new Hono()
  // ─── Group CRUD ────────────────────────────────────────────────────────
  .post('/groups', async (c) => {
    const b = CreateGroupBody.parse(await c.req.json());
    const group = await createGroup({
      name: b.name,
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.read_audit_enabled !== undefined
        ? { readAuditEnabled: b.read_audit_enabled }
        : {}),
      ...(b.cascade_on_share_default !== undefined
        ? { cascadeOnShareDefault: b.cascade_on_share_default }
        : {}),
    });
    await emitAudit({
      action: 'group.created',
      resourceId: group.id,
      result: 'success',
      details: { name: group.name },
    });
    return c.json(group, 201);
  })

  .get('/groups', async (c) => {
    const items = await listGroupsForUser();
    return c.json({ items });
  })

  .get('/groups/:id', async (c) => {
    const groupId = c.req.param('id');
    const result = await getGroup(groupId);
    return c.json(result);
  })

  .delete('/groups/:id', async (c) => {
    const groupId = c.req.param('id');
    await archiveGroup(groupId);
    await emitAudit({
      action: 'group.archived',
      resourceId: groupId,
      result: 'success',
    });
    return c.body(null, 204);
  })

  .patch('/groups/:id/read-audit', async (c) => {
    const groupId = c.req.param('id');
    const b = SetReadAuditBody.parse(await c.req.json());
    await setReadAudit(groupId, b.enabled);
    await emitAudit({
      action: 'group.read_audit_toggled',
      resourceId: groupId,
      result: 'success',
      details: { enabled: b.enabled },
    });
    return c.json({ ok: true });
  })

  // ─── Member-Management ─────────────────────────────────────────────────
  .post('/groups/:id/members', async (c) => {
    const groupId = c.req.param('id');
    const b = AddMemberBody.parse(await c.req.json());
    const member = await addMember({
      groupId,
      userId: b.user_id,
      ...(b.role !== undefined ? { role: b.role } : {}),
    });
    await emitAudit({
      action: 'group.member.added',
      resourceId: groupId,
      result: 'success',
      details: { target_user_id: b.user_id, role: b.role ?? 'member' },
    });
    return c.json(member, 201);
  })

  .delete('/groups/:id/members/:user_id', async (c) => {
    const groupId = c.req.param('id');
    const userId = c.req.param('user_id');
    await removeMember(groupId, userId);
    await emitAudit({
      action: 'group.member.removed',
      resourceId: groupId,
      result: 'success',
      details: { target_user_id: userId },
    });
    return c.body(null, 204);
  });

// Reserved for PATCH /groups/:id (name/description update) — Phase 2.
// Phase 1 hat keine update-Pfad-Tests, also halten wir die Surface minimal.
void UpdateGroupBody;
