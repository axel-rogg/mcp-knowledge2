/**
 * Phase 3b.4 — users.resolve_email Tool.
 *
 * Email → user-Lookup für die Transfer-Empfaenger-Auswahl. Liefert nur
 * Users die in der users-Tabelle bekannt sind (signup oder akzeptierter
 * Invite). Unbekannte → 404 → PWA zeigt "Empfaenger nicht registriert".
 *
 * Sensitivity='read'. Kein WYSIWYS-display-template noetig (read-only lookup).
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { users } from '../../db/schema.ts';
import { withUserTx } from '../../db/client.ts';
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

const UsersResolveEmailInput = z
  .object({
    email: z.string().email(),
  })
  .strict();

export function registerUsersResolveTools(): void {
  registerTool({
    name: 'users.resolve_email',
    description:
      'Resolve an email address to a registered user (id + display name + status). Returns 404 if the email is not registered. Used by the PWA to validate the recipient before objects.transfer_ownership.',
    inputSchema: zodToJsonSchema(UsersResolveEmailInput),
    annotations: {
      title: 'Resolve email to user',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = UsersResolveEmailInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      const result = await withUserTx(ctx.userId, ctx.requestId, async (db) => {
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            status: users.status,
          })
          .from(users)
          .where(eq(users.email, input.email.toLowerCase()))
          .limit(1);
        if (rows.length === 0) return null;
        const r = rows[0]!;
        return {
          userId: r.id,
          email: r.email,
          displayName: r.displayName,
          status: r.status,
        };
      });

      if (!result) {
        return jsonResult({ found: false, email: input.email });
      }
      return jsonResult({ found: true, ...result });
    },
  });
}
