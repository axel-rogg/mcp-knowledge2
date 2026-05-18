// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// groups.* — 10 Tools für Group-Sharing-Surface.
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md
//
// Approval2-Pendant: apps/server/src/tools/groups-tools.ts. Schemas, namings,
// sensitivity-Werte und displayTemplate sind 1:1 portiert damit der Auto-
// Forwarder in approval2 keinen Schema-Drift detektiert.
//
// Sub-Set der hier registrierten Tools:
//   - groups.create             (write)
//   - groups.list               (read)
//   - groups.get                (read)
//   - groups.list_members       (read)
//   - groups.add_member         (write)
//   - groups.remove_member      (danger) — triggert Master-Key-Rotation
//   - groups.invite_email       (write) — email→userId via users-Table-Lookup
//   - groups.archive            (danger) — soft-archive, owner-only
//   - groups.set_read_audit     (write) — toggle audit-Setting
//   - groups.transfer_ownership (danger)
//
// groups.invite_email: in KC2 ist der approval2-spezifische email_outbox-Pfad
// (Platform-Invite) nicht vorhanden — dieses Tool liefert daher direkt einen
// users-Lookup-Fehler wenn der User nicht existiert; das approval2-Layer
// schickt dann einen Platform-Invite (out-of-scope hier).

import { z } from 'zod';
import { eq } from 'drizzle-orm';

import {
  addMember,
  archiveGroup,
  createGroup,
  getGroup,
  listGroupsForUser,
  removeMember,
  setReadAudit,
  transferGroupOwnership,
} from '../../storage/groups.ts';
import { users } from '../../db/schema.ts';
import { withUserTx } from '../../db/client.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest, errNotFound } from '../../lib/errors.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

// ─── Zod-Schemas (1:1 aus approval2/apps/server/src/tools/groups-tools.ts) ───

const GroupsCreateInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    read_audit_enabled: z.boolean().optional(),
    cascade_on_share_default: z.boolean().optional(),
  })
  .strict();

const GroupsListInput = z.object({}).strict();

const GroupsGetInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();

const GroupsListMembersInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();

const GroupsAddMemberInput = z
  .object({
    group_id: z.string().uuid(),
    user_id: z.string().uuid(),
    role: z.enum(['admin', 'member']).optional(),
  })
  .strict();

const GroupsRemoveMemberInput = z
  .object({
    group_id: z.string().uuid(),
    user_id: z.string().uuid(),
  })
  .strict();

const GroupsInviteEmailInput = z
  .object({
    group_id: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(['admin', 'member']).optional(),
  })
  .strict();

const GroupsArchiveInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();

const GroupsSetReadAuditInput = z
  .object({
    group_id: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();

const GroupsTransferOwnershipInput = z
  .object({
    group_id: z.string().uuid(),
    new_owner_user_id: z.string().uuid(),
  })
  .strict();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerGroupsTools(): void {
  registerTool({
    name: 'groups.create',
    description:
      'Create a new sharing group. The current user becomes the group owner + first admin member. Other users can be added later via groups.add_member.',
    inputSchema: zodToJsonSchema(GroupsCreateInput),
    annotations: {
      title: 'Create group',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Create new sharing group: "{{name}}"',
      },
    },
    handler: async (args) => {
      const input = GroupsCreateInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        const view = await createGroup({
          name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.read_audit_enabled !== undefined
            ? { readAuditEnabled: input.read_audit_enabled }
            : {}),
          ...(input.cascade_on_share_default !== undefined
            ? { cascadeOnShareDefault: input.cascade_on_share_default }
            : {}),
        });
        await emitAudit({ action: 'groups.create', resourceId: view.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await emitAudit({ action: 'groups.create', result: 'error' });
        throw e;
      }
    },
  });

  registerTool({
    name: 'groups.list',
    description: 'List the groups the current user owns or is a member of.',
    inputSchema: zodToJsonSchema(GroupsListInput),
    annotations: {
      title: 'List groups',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      GroupsListInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const items = await listGroupsForUser();
      return jsonResult({ items });
    },
  });

  registerTool({
    name: 'groups.get',
    description:
      'Read a group and its member list. Both owner and active members can read; non-members get a not-found error from RLS.',
    inputSchema: zodToJsonSchema(GroupsGetInput),
    annotations: {
      title: 'Get group',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = GroupsGetInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const result = await getGroup(input.group_id);
      return jsonResult(result);
    },
  });

  registerTool({
    name: 'groups.list_members',
    description:
      'List active members of a group. Convenience wrapper around groups.get returning only the members slice.',
    inputSchema: zodToJsonSchema(GroupsListMembersInput),
    annotations: {
      title: 'List group members',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = GroupsListMembersInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const { members } = await getGroup(input.group_id);
      return jsonResult({ items: members });
    },
  });

  registerTool({
    name: 'groups.add_member',
    description:
      'Add a user to a sharing group. **Important:** the user can read ALL group-shared content immediately after this action. The action is reversible (groups.remove_member triggers a master-key rotation), but already-read content can never be recalled.',
    inputSchema: zodToJsonSchema(GroupsAddMemberInput),
    annotations: {
      title: 'Add group member',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template:
          'Add user {{user_id}} as {{role}} to group {{group_id}} — they will be able to read ALL group-shared content immediately.',
      },
    },
    handler: async (args) => {
      const input = GroupsAddMemberInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        const view = await addMember({
          groupId: input.group_id,
          userId: input.user_id,
          ...(input.role !== undefined ? { role: input.role } : {}),
        });
        await emitAudit({
          action: 'groups.add_member',
          resourceId: input.group_id,
          result: 'success',
          details: { target_user_id: input.user_id, role: input.role ?? 'member' },
        });
        return jsonResult(view);
      } catch (e) {
        await emitAudit({
          action: 'groups.add_member',
          resourceId: input.group_id,
          result: 'error',
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'groups.remove_member',
    description:
      'Remove a user from a sharing group. Triggers a master-key rotation: the removed user cannot read newly-shared content. Already-downloaded content cannot be recalled.',
    inputSchema: zodToJsonSchema(GroupsRemoveMemberInput),
    annotations: {
      title: 'Remove group member',
      sensitivity: 'danger',
      write: true,
      destructiveHint: true,
      wysiwys: {
        display_template:
          'Remove user {{user_id}} from group {{group_id}} (master-key rotation will be triggered).',
      },
    },
    handler: async (args) => {
      const input = GroupsRemoveMemberInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        await removeMember(input.group_id, input.user_id);
        await emitAudit({
          action: 'groups.remove_member',
          resourceId: input.group_id,
          result: 'success',
          details: { target_user_id: input.user_id },
        });
        return jsonResult({ ok: true });
      } catch (e) {
        await emitAudit({
          action: 'groups.remove_member',
          resourceId: input.group_id,
          result: 'error',
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'groups.invite_email',
    description:
      'Add a user to a group by email (MVP: user must already exist as active platform user). Looks up the user via the users table, then calls groups.add_member with their userId. If the email is not yet registered, an admin must first send a platform invite via approval2 /admin/invites. Future versions will fold platform-invite + group-add into a single ceremony.',
    inputSchema: zodToJsonSchema(GroupsInviteEmailInput),
    annotations: {
      title: 'Invite by email',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template:
          'Invite {{email}} as {{role}} to group {{group_id}} (resolves email→userId; user must already exist).',
      },
    },
    handler: async (args) => {
      const input = GroupsInviteEmailInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      // Look up user by email (case-insensitive via CITEXT column).
      const found = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
        const rows = await db
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);
        return rows[0] ?? null;
      });
      if (!found) {
        throw errNotFound(
          `no user found with email ${input.email}. ` +
            'Ask an admin to send a platform invite via approval2 /admin/invites first.',
        );
      }
      if (found.status !== 'active') {
        throw errBadRequest(
          `user ${input.email} exists but status='${found.status}' (not active). ` +
            'Wait until they accept the platform invite, then retry.',
        );
      }

      try {
        const added = await addMember({
          groupId: input.group_id,
          userId: found.id,
          ...(input.role !== undefined ? { role: input.role } : {}),
        });
        await emitAudit({
          action: 'groups.invite_email',
          resourceId: input.group_id,
          result: 'success',
          details: {
            email: input.email,
            resolved_user_id: found.id,
            role: input.role ?? 'member',
          },
        });
        return jsonResult({ added, resolvedUserId: found.id });
      } catch (e) {
        await emitAudit({
          action: 'groups.invite_email',
          resourceId: input.group_id,
          result: 'error',
          details: { email: input.email },
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'groups.archive',
    description:
      'Archive a group (owner-only, soft-delete). Existing share grants stay readable until explicitly revoked; new shares cannot target an archived group. Reversible only via direct DB ops.',
    inputSchema: zodToJsonSchema(GroupsArchiveInput),
    annotations: {
      title: 'Archive group',
      sensitivity: 'danger',
      write: true,
      destructiveHint: true,
      wysiwys: {
        display_template:
          'Archive group {{group_id}} (soft-delete; existing shares remain readable until revoked).',
      },
    },
    handler: async (args) => {
      const input = GroupsArchiveInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        await archiveGroup(input.group_id);
        await emitAudit({
          action: 'groups.archive',
          resourceId: input.group_id,
          result: 'success',
        });
        return jsonResult({ ok: true });
      } catch (e) {
        await emitAudit({
          action: 'groups.archive',
          resourceId: input.group_id,
          result: 'error',
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'groups.set_read_audit',
    description:
      'Toggle read-audit logging for a group (owner-only). When enabled, every member read on a group-shared object emits an audit event with the reader user-id. Useful for sensitive groups; off by default to minimise audit volume.',
    inputSchema: zodToJsonSchema(GroupsSetReadAuditInput),
    annotations: {
      title: 'Set read-audit',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Set read-audit on group {{group_id}} to {{enabled}}.',
      },
    },
    handler: async (args) => {
      const input = GroupsSetReadAuditInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        await setReadAudit(input.group_id, input.enabled);
        await emitAudit({
          action: 'groups.set_read_audit',
          resourceId: input.group_id,
          result: 'success',
          details: { enabled: input.enabled },
        });
        return jsonResult({ ok: true, enabled: input.enabled });
      } catch (e) {
        await emitAudit({
          action: 'groups.set_read_audit',
          resourceId: input.group_id,
          result: 'error',
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'groups.transfer_ownership',
    description:
      'Transfer group ownership to another user (owner-only, danger). The new owner MUST already be an active group member. Both old and new owner remain as admin members; no master-key rotation is performed (the new owner already has access via their wrappedGroupDek). Reversible only by the new owner transferring back.',
    inputSchema: zodToJsonSchema(GroupsTransferOwnershipInput),
    annotations: {
      title: 'Transfer ownership',
      sensitivity: 'danger',
      write: true,
      destructiveHint: true,
      wysiwys: {
        display_template:
          'TRANSFER ownership of group {{group_id}} to user {{new_owner_user_id}}. You lose owner-level privileges (add/remove members, archive, share-with-group); the new owner gains them. Both remain as admin members.',
      },
    },
    handler: async (args) => {
      const input = GroupsTransferOwnershipInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        await transferGroupOwnership(input.group_id, input.new_owner_user_id);
        await emitAudit({
          action: 'groups.transfer_ownership',
          resourceId: input.group_id,
          result: 'success',
          details: { new_owner_user_id: input.new_owner_user_id },
        });
        return jsonResult({ ok: true, newOwnerUserId: input.new_owner_user_id });
      } catch (e) {
        await emitAudit({
          action: 'groups.transfer_ownership',
          resourceId: input.group_id,
          result: 'error',
        });
        throw e;
      }
    },
  });
}

