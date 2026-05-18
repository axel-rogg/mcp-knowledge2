// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// sharing helpers — high-level Wrapper auf shares.create/listSharesForGroup/
// listSharedWithMe für die approval2-PWA-Surfaces.
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md
//
// Tool-Inventar:
//   - docs.share_with_group     (write) — wraps createShareWithGroup für subtype='doc'
//   - skills.share_with_group   (write) — wraps createShareWithGroup für subtype='skill_manifest'
//   - shares.list_my_shares     (read)  — owner-perspective inbound view
//   - shares.list_for_group     (read)  — group-perspective bidirectional view
//
// shares.revoke ist bereits low-level in register_tools.ts registriert
// (createShareWithGroup-Pendant), daher hier NICHT noch einmal registrieren —
// das Spec-File markiert es explizit als "skip falls vorhanden".
//
// docs.share_with_group: kein Cascade — nur das eine Doc wird geshared.
// skills.share_with_group: Storage-Layer triggert via Cascade-Hook bei
// addRef(role='skill_resource') automatisch das Sharing aller verlinkten
// Resource-Docs (Phase-1, vgl. revokeCascadeSharesFrom in shares.ts).

import { z } from 'zod';

import {
  createShareWithGroup,
  listSharedWithMe,
  listSharesForGroup,
} from '../../storage/shares.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest } from '../../lib/errors.ts';
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

const DocsShareWithGroupInput = z
  .object({
    doc_id: z.string().uuid(),
    group_id: z.string().uuid(),
    scope: z.enum(['read', 'write']).optional(),
    expires_at: z.number().int().nullable().optional(),
  })
  .strict();

const SkillsShareWithGroupInput = z
  .object({
    skill_id: z.string().uuid(),
    group_id: z.string().uuid(),
    scope: z.enum(['read', 'write']).optional(),
    expires_at: z.number().int().nullable().optional(),
  })
  .strict();

const SharesListMySharesInput = z.object({}).strict();

const SharesListForGroupInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerSharingTools(): void {
  registerTool({
    name: 'docs.share_with_group',
    description:
      'Share a single document with a group. Default scope is "read"; pass scope="write" for Co-Edit (P2-3) — active members can then UPDATE the doc body. NO auto-cascade — only this exact document is shared. For skill-bundle-sharing including all linked docs use skills.share_with_group.',
    inputSchema: zodToJsonSchema(DocsShareWithGroupInput),
    annotations: {
      title: 'Share doc with group',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template:
          'Share document {{doc_id}} with group {{group_id}} (scope={{scope}}, single-doc, no cascade).',
      },
    },
    handler: async (args) => {
      const input = DocsShareWithGroupInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const scope = input.scope ?? 'read';
      try {
        const share = await createShareWithGroup({
          resourceId: input.doc_id,
          groupId: input.group_id,
          scope,
          ...(input.expires_at !== undefined ? { expiresAt: input.expires_at } : {}),
        });
        await emitAudit({
          action: 'docs.share_with_group',
          resourceId: input.doc_id,
          result: 'success',
          details: { group_id: input.group_id, scope },
        });
        return jsonResult(share);
      } catch (e) {
        await emitAudit({
          action: 'docs.share_with_group',
          resourceId: input.doc_id,
          result: 'error',
          details: { group_id: input.group_id },
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'skills.share_with_group',
    description:
      'Share a skill (and all linked skill_resource documents via auto-cascade) with a group. Default scope is "read"; pass scope="write" for Co-Edit (P2-3) — active members can then UPDATE the skill body. Use shares.revoke to undo.',
    inputSchema: zodToJsonSchema(SkillsShareWithGroupInput),
    annotations: {
      title: 'Share skill with group',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template:
          'Share skill {{skill_id}} with group {{group_id}} (scope={{scope}}). All linked skill_resource documents are auto-shared via cascade.',
      },
    },
    handler: async (args) => {
      const input = SkillsShareWithGroupInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const scope = input.scope ?? 'read';
      try {
        const share = await createShareWithGroup({
          resourceId: input.skill_id,
          groupId: input.group_id,
          scope,
          ...(input.expires_at !== undefined ? { expiresAt: input.expires_at } : {}),
        });
        await emitAudit({
          action: 'skills.share_with_group',
          resourceId: input.skill_id,
          result: 'success',
          details: { group_id: input.group_id, scope },
        });
        return jsonResult(share);
      } catch (e) {
        await emitAudit({
          action: 'skills.share_with_group',
          resourceId: input.skill_id,
          result: 'error',
          details: { group_id: input.group_id },
        });
        throw e;
      }
    },
  });

  registerTool({
    name: 'shares.list_my_shares',
    description:
      'List all shares granted TO the current user (inbound view) — either as direct user-grants or via group membership. Useful for "Shared with me" surfaces. Returns share rows, not the objects themselves; fetch resourceId via objects.read for body.',
    inputSchema: zodToJsonSchema(SharesListMySharesInput),
    annotations: {
      title: 'Shared with me',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      SharesListMySharesInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const items = await listSharedWithMe();
      return jsonResult({ items });
    },
  });

  registerTool({
    name: 'shares.list_for_group',
    description:
      'List all active share-grants targeting a specific group. Caller must be group member (RLS-enforced). Non-member receives empty list (silent, no 403). Useful for "what is shared with this team" view.',
    inputSchema: zodToJsonSchema(SharesListForGroupInput),
    annotations: {
      title: 'List shares for group',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = SharesListForGroupInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const items = await listSharesForGroup(input.group_id);
      return jsonResult({ items });
    },
  });
}
