/**
 * Phase 3b.4 — Generic Ownership-Tools auf Objects.
 *
 * Drei Tools, alle approval-pflichtig:
 *   - objects.move_to_group       (write)
 *   - objects.move_to_personal    (write)
 *   - objects.transfer_ownership  (danger)  — Decision 9: hard confirm
 *
 * Generisch über alle Subtypes (doc/note/list/skill_manifest/app:* etc.) —
 * Phase 3b §A2: "warum kein generische funktionen auf Objekte anstatt für
 * alles ein wrapper?". Wrapper-Doctrine A1 deckt nur Read/Update-Surfaces
 * mit konventionsspezifischer Validierung; Ownership-Move ist kind-agnostic.
 *
 * Spec: docs/plans/active/PLAN-generic-objects-and-group-ownership.md §3b.4
 */

import { z } from 'zod';

import {
  moveObjectToGroup,
  moveObjectToPersonal,
  transferObjectOwnership,
} from '../../storage/group-ownership-crypto.ts';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.ts';
import { withUserTx } from '../../db/client.ts';
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

const ObjectsMoveToGroupInput = z
  .object({
    object_id: z.string().uuid(),
    group_id: z.string().uuid(),
  })
  .strict();

const ObjectsMoveToPersonalInput = z
  .object({
    object_id: z.string().uuid(),
  })
  .strict();

const ObjectsTransferOwnershipInput = z
  .object({
    object_id: z.string().uuid(),
    new_owner_id: z.string().uuid().optional(),
    new_owner_email: z.string().email().optional(),
  })
  .strict()
  .refine((d) => Boolean(d.new_owner_id) !== Boolean(d.new_owner_email), {
    message: 'exactly one of new_owner_id or new_owner_email required',
  });

export function registerObjectsOwnershipTools(): void {
  registerTool({
    name: 'objects.move_to_group',
    description:
      'Move an object from personal ownership to a sharing group. The current owner must call this; the target group must exist, not be archived, and the caller must be an active member. All active members of the group will get read+write access to the object via the group master key. Subtype-agnostic — works for docs, notes, lists, skills, apps, memos, etc.',
    inputSchema: zodToJsonSchema(ObjectsMoveToGroupInput),
    annotations: {
      title: 'Move object to group',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Move object {{object_id}} to group {{group_id}}',
      },
    },
    handler: async (args) => {
      const input = ObjectsMoveToGroupInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await moveObjectToGroup({
        objectId: input.object_id,
        groupId: input.group_id,
      });
      return jsonResult({
        ok: true,
        objectId: input.object_id,
        owningGroupId: input.group_id,
      });
    },
  });

  registerTool({
    name: 'objects.move_to_personal',
    description:
      'Move an object from group ownership to your personal ownership. Caller must be an active member of the owning group. Other group members will lose new-read access (already-loaded content cannot be recalled). The group master key is NOT rotated — single-object-move stays scoped to one object.',
    inputSchema: zodToJsonSchema(ObjectsMoveToPersonalInput),
    annotations: {
      title: 'Move object to personal',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Move object {{object_id}} to personal ownership',
      },
    },
    handler: async (args) => {
      const input = ObjectsMoveToPersonalInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await moveObjectToPersonal({ objectId: input.object_id });
      return jsonResult({
        ok: true,
        objectId: input.object_id,
        ownerId: ctx.userId,
      });
    },
  });

  registerTool({
    name: 'objects.transfer_ownership',
    description:
      'Transfer an object to another user. Caller must be the current owner; the recipient must be a registered active user. Cross-user write — sensitivity is "danger" (hard-confirm). The recipient gains exclusive access; caller loses access immediately. Cannot be undone without recipient cooperation.',
    inputSchema: zodToJsonSchema(ObjectsTransferOwnershipInput),
    annotations: {
      title: 'Transfer object ownership',
      sensitivity: 'danger',
      write: true,
      wysiwys: {
        display_template:
          'Transfer object {{object_id}} ownership to {{new_owner_email}}{{new_owner_id}}',
      },
    },
    handler: async (args) => {
      const input = ObjectsTransferOwnershipInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      let newOwnerUserId = input.new_owner_id;
      if (!newOwnerUserId && input.new_owner_email) {
        newOwnerUserId = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
          const rows = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, input.new_owner_email!.toLowerCase()))
            .limit(1);
          if (rows.length === 0) {
            throw errNotFound(`user with email ${input.new_owner_email} not registered`);
          }
          return rows[0]!.id;
        });
      }
      if (!newOwnerUserId) {
        throw errBadRequest('new_owner_id or new_owner_email required');
      }

      await transferObjectOwnership({
        objectId: input.object_id,
        newOwnerUserId,
      });
      return jsonResult({
        ok: true,
        objectId: input.object_id,
        newOwnerId: newOwnerUserId,
      });
    },
  });
}
