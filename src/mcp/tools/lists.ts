// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// lists.* — 6 Tools über subtype='list'. Markdown-Checkbox-Listen.
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md
// Approval2-Pendant (vor Migration): apps/server/src/tools/lists-tools.ts.
//
// Body-Format (strict):
//
//   # Title                  <- optional H1 (1. Zeile)
//
//   - [ ] Item 1
//   - [x] Item 2 #tag        <- optional #tag-Suffix
//
// Body ist plain UTF-8 (kein base64) — Wrapper kodiert/dekodiert hier, KC2-
// Storage selbst akzeptiert opaque ciphertext.
//
// Toggle-Semantik (tick/untick): liest doc mit body, flippt `[ ]` ↔ `[x]` per
// Text-Substring-Match (case-insensitive) ODER zero-basiertem Line-Index
// (zaehlt nur item-Zeilen, ueberspringt H1+Leerzeilen), schreibt vollen Body
// zurueck. Beide Match-Mechanismen MUESSEN unterstuetzt werden — eines der
// beiden Felder ist Pflicht (Schema-Refine).

import { z } from 'zod';

import { createObject, listObjects, readObject, updateObject } from '../../storage/objects.ts';
import { assertObjectQuota, releaseObjectQuota } from '../../quota/check.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest } from '../../lib/errors.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

const SUBTYPE_LIST = 'list';
const MAX_ITEMS = 120;

const ITEM_LINE_RE = /^- \[[ xX]\] .+(\s+#[a-z0-9_-]{1,32})*$/;
const HEADER_LINE_RE = /^# .+$/;

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

// ─── Body validators / helpers (ported from approval2/lists-tools.ts) ─────────

/**
 * Validiert das Markdown-Checkbox-Body-Format einer Liste.
 * Wirft Error mit Zeilen-Index bei Format-Verstoss.
 */
function validateListBody(body: string): void {
  const lines = body.split('\n');
  let itemCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (i === 0 && HEADER_LINE_RE.test(line)) continue;
    if (line.trim() === '') continue;
    if (ITEM_LINE_RE.test(line)) {
      itemCount += 1;
      if (itemCount > MAX_ITEMS) {
        throw errBadRequest(`lists: too many items (max ${MAX_ITEMS})`);
      }
      continue;
    }
    throw errBadRequest(
      `lists: line ${i + 1} is not a valid checkbox item: ${JSON.stringify(line)}`,
    );
  }
}

/**
 * Baut den Markdown-Body aus title + items[].
 * Title wird als H1 vorangestellt; Items als `- [ ] <text>`-Zeilen.
 */
function buildListBody(title: string, items: ReadonlyArray<string>): string {
  const itemLines = items.map((it) => `- [ ] ${it}`);
  return [`# ${title}`, '', ...itemLines].join('\n');
}

/**
 * Findet die Item-Zeilen-Indizes (0-based, bezogen auf split('\n')) im Body.
 */
function findItemLineIndices(body: string): { lines: string[]; itemIndices: number[] } {
  const lines = body.split('\n');
  const itemIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (ITEM_LINE_RE.test(line)) itemIndices.push(i);
  }
  return { lines, itemIndices };
}

/**
 * Aufloesung Zielzeile fuer tick/untick — via line_index ODER match.
 */
function resolveTargetLineIndex(
  body: string,
  args: { match?: string; line_index?: number },
): number {
  const { lines, itemIndices } = findItemLineIndices(body);
  if (args.line_index !== undefined) {
    const target = itemIndices[args.line_index];
    if (target === undefined) {
      throw errBadRequest(
        `lists: line_index ${args.line_index} out of range (have ${itemIndices.length} items)`,
      );
    }
    return target;
  }
  if (args.match !== undefined) {
    const needle = args.match.toLowerCase();
    for (const idx of itemIndices) {
      const line = lines[idx] ?? '';
      if (line.toLowerCase().includes(needle)) return idx;
    }
    throw errBadRequest(`lists: no item matching ${JSON.stringify(args.match)}`);
  }
  throw errBadRequest('lists: must provide match or line_index');
}

function toggleCheckbox(line: string, to: 'x' | ' '): string {
  return line.replace(/^- \[[ xX]\] /, `- [${to}] `);
}

// ─── Zod-Schemas (mirror approval2/apps/server/src/tools/types.ts) ───────────

const CreateInput = z
  .object({
    title: z.string().min(1).max(200),
    items: z.array(z.string().min(1).max(280)).max(120).optional(),
  })
  .strict();

const AddItemInput = z
  .object({
    id: z.string().min(1).max(128),
    item: z.string().min(1).max(280),
    tag: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_-]+$/)
      .optional(),
  })
  .strict();

const TickInput = z
  .object({
    id: z.string().min(1).max(128),
    /** Text-substring (case-insensitive) used to identify the item. */
    match: z.string().min(1).max(280).optional(),
    /** Zero-based line index alternative (counts only `- [ ]/[x]` rows). */
    line_index: z.number().int().nonnegative().max(120).optional(),
  })
  .strict()
  .refine((v) => v.match !== undefined || v.line_index !== undefined, {
    message: 'one of match or line_index must be provided',
  });

// untick uses the same schema shape as tick.
const UntickInput = TickInput;

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const GetInput = z.object({ id: z.string().min(1).max(128) }).strict();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerListsTools(): void {
  // ── lists.create ────────────────────────────────────────────────────────────
  registerTool({
    name: 'lists.create',
    description:
      'Create a new checkbox list with a title and optional initial items. Body is Markdown with `- [ ] item` lines.',
    inputSchema: zodToJsonSchema(CreateInput),
    annotations: {
      title: 'Create list',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Create list: {{title}} ({{items.length}} items)',
      },
    },
    handler: async (args) => {
      const input = CreateInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const items = input.items ?? [];
      if (items.length > MAX_ITEMS) {
        throw errBadRequest(`lists.create: too many items (max ${MAX_ITEMS})`);
      }
      const bodyText = buildListBody(input.title, items);
      validateListBody(bodyText);
      const body = utf8(bodyText);
      await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: body.byteLength });
      try {
        const view = await createObject({
          subtype: SUBTYPE_LIST,
          title: input.title,
          body,
        });
        await emitAudit({ action: 'lists.create', resourceId: view.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await releaseObjectQuota(ctx.userId, ctx.requestId, body.byteLength);
        await emitAudit({ action: 'lists.create', result: 'error' });
        throw e;
      }
    },
  });

  // ── lists.add_item ─────────────────────────────────────────────────────────
  registerTool({
    name: 'lists.add_item',
    description:
      'Append a single item to an existing list. Body is read+rewritten; tag is appended as ` #tag` if provided.',
    inputSchema: zodToJsonSchema(AddItemInput),
    annotations: {
      title: 'Add list item',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Add to list {{id}}: "{{item}}"{{#tag}} #{{tag}}{{/tag}}',
      },
    },
    handler: async (args) => {
      const input = AddItemInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      try {
        const { body: currentBody } = await readObject(input.id, { includeBody: true });
        if (currentBody === undefined) {
          throw errBadRequest('lists.add_item: list body missing');
        }
        const bodyText = fromUtf8(currentBody);
        const { itemIndices } = findItemLineIndices(bodyText);
        if (itemIndices.length >= MAX_ITEMS) {
          throw errBadRequest(`lists.add_item: list already at max items (${MAX_ITEMS})`);
        }
        const tagSuffix = input.tag !== undefined ? ` #${input.tag}` : '';
        const newLine = `- [ ] ${input.item}${tagSuffix}`;
        const nextBodyText = bodyText.endsWith('\n')
          ? bodyText + newLine
          : bodyText + '\n' + newLine;
        validateListBody(nextBodyText);
        const view = await updateObject(input.id, { body: utf8(nextBodyText) });
        await emitAudit({ action: 'lists.add_item', resourceId: input.id, result: 'success' });
        return jsonResult(view);
      } catch (e) {
        await emitAudit({ action: 'lists.add_item', resourceId: input.id, result: 'error' });
        throw e;
      }
    },
  });

  // ── lists.tick + lists.untick (gemeinsamer Toggle-Pfad) ────────────────────
  const registerToggle = (
    name: 'lists.tick' | 'lists.untick',
    schema: typeof TickInput | typeof UntickInput,
    target: 'x' | ' ',
    title: string,
    description: string,
    displayTemplate: string,
  ): void => {
    registerTool({
      name,
      description,
      inputSchema: zodToJsonSchema(schema),
      annotations: {
        title,
        sensitivity: 'write',
        write: true,
        wysiwys: { display_template: displayTemplate },
      },
      handler: async (args) => {
        const input = schema.parse(args);
        const ctx = requireContext();
        if (!ctx.userId) throw errBadRequest('user context required');
        try {
          const { body: currentBody } = await readObject(input.id, { includeBody: true });
          if (currentBody === undefined) {
            throw errBadRequest(`${name}: list body missing`);
          }
          const bodyText = fromUtf8(currentBody);
          const resolveArgs: { match?: string; line_index?: number } = {};
          if (input.match !== undefined) resolveArgs.match = input.match;
          if (input.line_index !== undefined) resolveArgs.line_index = input.line_index;
          const idx = resolveTargetLineIndex(bodyText, resolveArgs);
          const lines = bodyText.split('\n');
          const original = lines[idx] ?? '';
          lines[idx] = toggleCheckbox(original, target);
          const nextBodyText = lines.join('\n');
          validateListBody(nextBodyText);
          const view = await updateObject(input.id, { body: utf8(nextBodyText) });
          await emitAudit({ action: name, resourceId: input.id, result: 'success' });
          return jsonResult(view);
        } catch (e) {
          await emitAudit({ action: name, resourceId: input.id, result: 'error' });
          throw e;
        }
      },
    });
  };

  registerToggle(
    'lists.tick',
    TickInput,
    'x',
    'Tick list item',
    'Mark a list item as done. Match by text substring (case-insensitive) or zero-based line_index.',
    'Tick {{id}}: {{match}}{{^match}}line {{line_index}}{{/match}}',
  );

  registerToggle(
    'lists.untick',
    UntickInput,
    ' ',
    'Untick list item',
    'Mark a list item as not-done. Match by text substring (case-insensitive) or zero-based line_index.',
    'Untick {{id}}: {{match}}{{^match}}line {{line_index}}{{/match}}',
  );

  // ── lists.list ─────────────────────────────────────────────────────────────
  registerTool({
    name: 'lists.list',
    description: "List the current user's checkbox lists (subtype='list'). Supports paging via limit/cursor.",
    inputSchema: zodToJsonSchema(ListInput),
    annotations: {
      title: 'List lists',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = ListInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const opts: Parameters<typeof listObjects>[0] = { subtype: SUBTYPE_LIST };
      if (input.limit !== undefined) opts.limit = input.limit;
      if (input.cursor !== undefined) opts.cursor = input.cursor;
      const result = await listObjects(opts);
      // approval2-Compat: nextCursor (camelCase) ist primary; next_cursor
      // (snake_case) als Übergangs-Alias für 1 Sprint.
      return jsonResult({
        items: result.items,
        nextCursor: result.nextCursor,
        next_cursor: result.nextCursor,
      });
    },
  });

  // ── lists.get ──────────────────────────────────────────────────────────────
  registerTool({
    name: 'lists.get',
    description: 'Fetch a single list by id (body returned as plain UTF-8 Markdown string).',
    inputSchema: zodToJsonSchema(GetInput),
    annotations: {
      title: 'Get list',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = GetInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      const { view, body } = await readObject(input.id, { includeBody: true });
      const payload = {
        ...view,
        body: body !== undefined ? fromUtf8(body) : undefined,
      };
      return jsonResult(payload);
    },
  });
}
