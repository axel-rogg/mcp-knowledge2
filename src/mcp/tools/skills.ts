// AS-3 K11 Phase-1 (Wrapper-Migration aus approval2):
// skills.* — 9 Tools über subtype='skill_manifest'. Bundle aus Manifest
// (Markdown im body) + Resources (Docs, gelinkt via object_refs(role='resource')).
//
// Spec: docs/plans/active/PLAN-tool-surface-as-storage-canonical.md §2.5
//
// Approval2-Pendant (vor Migration): apps/server/src/tools/skills-tools.ts.
// Body ist plain UTF-8 (≤500 KB Markdown-Manifest), kein base64.
//
// Manifest-Parsing: approval2 hat KEINEN YAML-Frontmatter-Parser für Skill-
// Manifeste — der Body wird als-ist akzeptiert (kein Schema-Check über
// Title/Description). Sollte ein Parser nachgezogen werden, lebt er in
// `skills-manifest-parser.ts` (heute nicht angelegt — Phase-1-Decision).
//
// Refs-Model: kanonisch `object_refs(role='resource')` via `addRef`/`removeRef`
// (PLAN-document-linking §10.5 D4 P7). `meta.resource_ids[]` aus approval2
// ist Legacy-Pfad und wird hier nicht mehr geschrieben — get_bundle/
// read_resource/attach/detach lesen ausschliesslich `object_refs`.

import { z } from 'zod';

import {
  createObject,
  listObjects,
  readObject,
  softDeleteObject,
  updateObject,
} from '../../storage/objects.ts';
import {
  addRef,
  expandOutgoingRefBodies,
  listOutgoingRefs,
  listRefsForObject,
  removeRef,
  type RefsForObject,
} from '../../storage/refs.ts';
import { hybridSearch } from '../../search/hybrid.ts';
import { assertEmbedQuota, assertObjectQuota, releaseObjectQuota } from '../../quota/check.ts';
import { emitAudit } from '../../observability/audit.ts';
import { requireContext } from '../../lib/context.ts';
import { errBadRequest, errNotFound } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { registerTool } from '../tools.ts';
import type { CallToolResult } from '../types.ts';
import { zodToJsonSchema } from '../json-schema.ts';

const SUBTYPE_SKILL = 'skill_manifest';
const RESOURCE_ROLE = 'resource';

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * Builds a CallToolResult that includes the JSON text-block plus one
 * resource_link content-block per outgoing ref — analog to objects.get's
 * objectWithRefsResult. PLAN-document-linking §10.5 D1 (R1).
 */
function skillWithRefsResult(
  data: { refs?: RefsForObject } & Record<string, unknown>,
): CallToolResult {
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(data, null, 2) },
  ];
  const outgoing = data.refs?.outgoing ?? [];
  for (const r of outgoing) {
    content.push({
      type: 'resource_link',
      uri: r.uri,
      name: r.title ?? r.id,
      description: r.summary ?? undefined,
      mimeType: 'text/markdown',
      _meta: { role: r.role, subtype: r.subtype ?? undefined },
    } as unknown as CallToolResult['content'][number]);
  }
  return { content, structuredContent: data };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

// ─── Zod schemas (mirror approval2/apps/server/src/tools/types.ts) ──────────

const SkillsPutInput = z
  .object({
    id: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(200),
    manifest: z.string().min(1).max(500_000),
    description: z.string().max(2000).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    trigger_hints: z.string().max(2000).optional(),
    groups: z.array(z.string().min(1).max(64)).max(16).optional(),
    resource_ids: z.array(z.string().min(1).max(128)).max(32).optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();

const SkillsGetInput = z
  .object({
    id: z.string().min(1).max(128),
    expand_body: z.boolean().optional(),
  })
  .strict();

const SkillsListInput = z
  .object({
    group: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const SkillsDeleteInput = z
  .object({
    id: z.string().min(1).max(128),
    force: z.boolean().optional(),
  })
  .strict();

const SkillsSearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const SkillsReadResourceInput = z
  .object({
    skill_id: z.string().min(1).max(128),
    resource_id: z.string().min(1).max(128),
  })
  .strict();

const SkillsAttachResourceInput = z
  .object({
    skill_id: z.string().min(1).max(128),
    doc_id: z.string().min(1).max(128),
  })
  .strict();

const SkillsDetachResourceInput = z
  .object({
    skill_id: z.string().min(1).max(128),
    doc_id: z.string().min(1).max(128),
  })
  .strict();

const SkillsGetBundleInput = z
  .object({
    id: z.string().min(1).max(128),
    refs_limit: z.number().int().min(0).max(50).optional(),
  })
  .strict();

// ─── Registration ───────────────────────────────────────────────────────────

export function registerSkillsTools(): void {
  // ── skills.put — write ────────────────────────────────────────────────────
  registerTool({
    name: 'skills.put',
    description:
      'Create or update a skill (manifest in body, optional groups + linked resource_ids). ' +
      'If id is provided, upserts that skill; otherwise creates a new one. ' +
      'resource_ids[] is a convenience seed: when present on CREATE, each id is attached via ' +
      "object_refs(role='resource'). On UPDATE the field is ignored — use skills.attach_resource / " +
      'skills.detach_resource for incremental ref management.',
    inputSchema: zodToJsonSchema(SkillsPutInput),
    annotations: {
      title: 'Save skill',
      sensitivity: 'write',
      write: true,
      wysiwys: {
        display_template: 'Save skill: {{title}}',
      },
    },
    handler: async (args) => {
      const input = SkillsPutInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      const body = utf8(input.manifest);
      const meta = buildSkillMeta(input);

      if (input.id !== undefined) {
        // UPDATE-Path — refs werden separat verwaltet (attach/detach).
        //
        // Lazy-Migration für legacy approval2-Skills: alte Skills haben
        // `meta.resource_ids[]` ohne korrespondierende `object_refs(role='resource')`.
        // Beim UPDATE wird `meta` durch den neuen patch ueberschrieben — ohne
        // diese Pre-Migration gingen die Resources lautlos verloren. Wir lesen
        // den bestehenden Object-State, vergleichen `meta.resource_ids[]` gegen
        // outgoing-refs(role='resource') und addRef() jeden fehlenden Eintrag.
        // Idempotent: bereits-vorhandene Refs werden via existierende
        // (from,to,role)-UNIQUE-Constraint übersprungen — wir prüfen aber
        // explizit, damit der Log-Count akkurat ist.
        try {
          const existing = await readObject(input.id, { includeBody: false });
          const legacyResourceIds = Array.isArray(existing.view.meta?.['resource_ids'])
            ? (existing.view.meta!['resource_ids'] as unknown[]).filter(
                (v): v is string => typeof v === 'string' && v.length > 0,
              )
            : [];
          if (legacyResourceIds.length > 0) {
            const outgoing = await listOutgoingRefs(input.id);
            const existingResourceTargets = new Set(
              outgoing.filter((r) => r.role === RESOURCE_ROLE).map((r) => r.toId),
            );
            const missing = legacyResourceIds.filter((rid) => !existingResourceTargets.has(rid));
            let migrated = 0;
            for (const rid of missing) {
              try {
                await addRef({ fromId: input.id, toId: rid, role: RESOURCE_ROLE });
                migrated += 1;
              } catch {
                // ignore individual addRef failures (target invisible /
                // not-found) — skill update should still succeed.
              }
            }
            if (migrated > 0) {
              logger.info(
                { skillId: input.id, migrated },
                'skills.put: lazy-migrated legacy meta.resource_ids[] to object_refs',
              );
            }
          }
        } catch {
          // pre-migration is best-effort — if it fails (e.g. object not
          // visible), let updateObject below surface the canonical error.
        }

        const patch: Parameters<typeof updateObject>[1] = {};
        patch.title = input.title;
        patch.body = body;
        if (input.description !== undefined) patch.description = input.description;
        if (input.keywords !== undefined) patch.keywords = [...input.keywords];
        if (input.trigger_hints !== undefined) patch.triggerHints = input.trigger_hints;
        if (input.expected_version !== undefined) patch.expectedVersion = input.expected_version;
        if (Object.keys(meta).length > 0) patch.meta = meta;
        try {
          const view = await updateObject(input.id, patch);
          await emitAudit({
            action: 'skills.put',
            resourceId: view.id,
            result: 'success',
          });
          return jsonResult(view);
        } catch (e) {
          await emitAudit({
            action: 'skills.put',
            resourceId: input.id,
            result: 'error',
          });
          throw e;
        }
      }

      // CREATE-Path
      await assertObjectQuota(ctx.userId, ctx.requestId, { bodySize: body.byteLength });
      // Skills nehmen ihre eigene FTS + Vector-Search ueber Title/Description/
      // Keywords/Trigger-Hints. Embedding ist immer empfehlenswert fuer
      // capability-search; quota wird hier vorab geprueft.
      await assertEmbedQuota(ctx.userId, ctx.requestId);
      try {
        const createArgs: Parameters<typeof createObject>[0] = {
          subtype: SUBTYPE_SKILL,
          title: input.title,
          body,
          embed: true,
        };
        if (input.description !== undefined) createArgs.description = input.description;
        if (input.keywords !== undefined) createArgs.keywords = [...input.keywords];
        if (input.trigger_hints !== undefined) createArgs.triggerHints = input.trigger_hints;
        if (Object.keys(meta).length > 0) createArgs.meta = meta;

        const view = await createObject(createArgs);

        // Seed resource_ids → addRef(role='resource') idempotent. Falls ein
        // einzelnes addRef fehlschlaegt (target nicht sichtbar etc.), wird
        // der Fehler propagiert — die Skill-Row existiert dann schon, der
        // User kann mit attach_resource nachsetzen.
        if (input.resource_ids !== undefined && input.resource_ids.length > 0) {
          for (const docId of input.resource_ids) {
            await addRef({
              fromId: view.id,
              toId: docId,
              role: RESOURCE_ROLE,
            });
          }
        }

        await emitAudit({
          action: 'skills.put',
          resourceId: view.id,
          result: 'success',
          details: { created: true, seeded_refs: input.resource_ids?.length ?? 0 },
        });
        return jsonResult(view);
      } catch (e) {
        await releaseObjectQuota(ctx.userId, ctx.requestId, body.byteLength);
        await emitAudit({ action: 'skills.put', result: 'error' });
        throw e;
      }
    },
  });

  // ── skills.get — read ─────────────────────────────────────────────────────
  registerTool({
    name: 'skills.get',
    description:
      'Fetch a skill (manifest body + meta + outgoing refs). Pass expand_body=true to include the manifest text. ' +
      'For the full bundle (manifest + all resource bodies in one call), use skills.get_bundle.',
    inputSchema: zodToJsonSchema(SkillsGetInput),
    annotations: {
      title: 'Get skill',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Read skill {{id}}' },
    },
    handler: async (args) => {
      const input = SkillsGetInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      const { view, body } = await readObject(input.id, {
        includeBody: input.expand_body ?? false,
      });
      if (view.subtype !== SUBTYPE_SKILL) {
        throw errNotFound(`object ${input.id} is not a skill`);
      }
      const refs = await listRefsForObject(input.id, 5);
      await emitAudit({ action: 'skills.get', resourceId: input.id, result: 'success' });

      const payload = {
        ...view,
        manifest: body !== undefined ? fromUtf8(body) : undefined,
        refs,
      };
      return skillWithRefsResult(payload);
    },
  });

  // ── skills.get_bundle — read (manifest + eager-loaded resources) ──────────
  registerTool({
    name: 'skills.get_bundle',
    description:
      'Read a skill manifest + ALL its attached resource bodies in one call. ' +
      'Useful for executing a skill (you need both the manifest and the resources). ' +
      'Returns the skill object with refs.outgoing[] where each role="resource" ' +
      'entry has its body inlined as base64. Subject to 200 KB total + 1 MB per-ref ' +
      'budget — oversized/over-budget refs come back without body and a truncatedReason. ' +
      'For pure manifest read use skills.get (no body fetch overhead on resources).',
    inputSchema: zodToJsonSchema(SkillsGetBundleInput),
    annotations: {
      title: 'Get skill bundle',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Read skill bundle {{id}}' },
    },
    handler: async (args) => {
      const input = SkillsGetBundleInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      const { view, body } = await readObject(input.id, { includeBody: true });
      if (view.subtype !== SUBTYPE_SKILL) {
        throw errNotFound(`object ${input.id} is not a skill`);
      }

      const refsLimit = input.refs_limit ?? 20;
      let refs: RefsForObject | undefined;
      if (refsLimit > 0) {
        const baseRefs = await listRefsForObject(input.id, refsLimit);
        // Eager-load bodies for role='resource' only.
        const expanded = await expandOutgoingRefBodies(baseRefs.outgoing, [RESOURCE_ROLE]);
        refs = { ...baseRefs, outgoing: expanded };
      }

      await emitAudit({
        action: 'skills.get_bundle',
        resourceId: input.id,
        result: 'success',
        details: { refs_count: refs?.outgoing.length ?? 0 },
      });

      const payload = {
        ...view,
        manifest: body !== undefined ? fromUtf8(body) : undefined,
        ...(refs !== undefined ? { refs } : {}),
      };
      return skillWithRefsResult(payload);
    },
  });

  // ── skills.list — read ────────────────────────────────────────────────────
  registerTool({
    name: 'skills.list',
    description:
      "List the current user's skills (subtype='skill_manifest'). Optional filter by group (meta.groups[]). Supports paging via limit/cursor.",
    inputSchema: zodToJsonSchema(SkillsListInput),
    annotations: {
      title: 'List skills',
      sensitivity: 'read',
      readOnlyHint: true,
    },
    handler: async (args) => {
      const input = SkillsListInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      const opts: Parameters<typeof listObjects>[0] = { subtype: SUBTYPE_SKILL };
      if (input.limit !== undefined) opts.limit = input.limit;
      if (input.cursor !== undefined) opts.cursor = input.cursor;

      const list = await listObjects(opts);

      // Client-side group filter (approval2-compat). Sub-optimal at scale —
      // a meta-jsonb GIN index + server-side filter is the right long-term
      // fix; meta.groups is rarely set today so this stays acceptable.
      if (input.group === undefined) return jsonResult(list);
      const target = input.group;
      const filtered = list.items.filter((obj) => {
        const groups = obj.meta?.['groups'];
        if (!Array.isArray(groups)) return false;
        return groups.includes(target);
      });
      // approval2-Compat: nextCursor (camelCase) ist primary; next_cursor (snake_case)
      // als Übergangs-Alias für 1 Sprint (analog lists.list / objects.browse_list).
      return jsonResult({ items: filtered, nextCursor: list.nextCursor, next_cursor: list.nextCursor });
    },
  });

  // ── skills.delete — danger ────────────────────────────────────────────────
  registerTool({
    name: 'skills.delete',
    description:
      'Soft-delete a skill. By default refuses if refcount>0 (incoming refs exist). ' +
      'Pass force=true to delete anyway (incoming refs will dangle until cleaned).',
    inputSchema: zodToJsonSchema(SkillsDeleteInput),
    annotations: {
      title: 'Delete skill',
      sensitivity: 'danger',
      destructiveHint: true,
      wysiwys: { display_template: 'DELETE skill {{id}}{{#force}} (force){{/force}}' },
    },
    handler: async (args) => {
      const input = SkillsDeleteInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      if (input.force !== true) {
        // refcount-aware-Pre-Check: reuse readObject; soft-delete itself
        // does not consult refcount (refcount is for incoming refs into
        // the skill — typical for sub-docs, less so for skills, but caller
        // contract is symmetric with approval2's wrapper).
        const { view } = await readObject(input.id, { includeBody: false });
        if (view.subtype !== SUBTYPE_SKILL) {
          throw errNotFound(`object ${input.id} is not a skill`);
        }
        if (view.refcount > 0) {
          throw errBadRequest(
            `skills.delete: skill is still referenced (refcount=${view.refcount}); pass force=true to override`,
          );
        }
      }

      try {
        await softDeleteObject(input.id);
        await emitAudit({
          action: 'skills.delete',
          resourceId: input.id,
          result: 'success',
          details: { force: input.force === true },
        });
        return jsonResult({ deleted: true, id: input.id });
      } catch (e) {
        await emitAudit({
          action: 'skills.delete',
          resourceId: input.id,
          result: 'error',
        });
        throw e;
      }
    },
  });

  // ── skills.search — read (hybrid FTS + Vector) ───────────────────────────
  registerTool({
    name: 'skills.search',
    description:
      'Hybrid search across skills (FTS + Vector via RRF fusion). Returns ranked hits restricted to subtype=skill_manifest.',
    inputSchema: zodToJsonSchema(SkillsSearchInput),
    annotations: {
      title: 'Search skills',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Search skills: "{{query}}"' },
    },
    handler: async (args) => {
      const input = SkillsSearchInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');
      await assertEmbedQuota(ctx.userId, ctx.requestId);

      const searchArgs: Parameters<typeof hybridSearch>[0] = {
        query: input.query,
        subtypes: [SUBTYPE_SKILL],
      };
      if (input.limit !== undefined) searchArgs.limit = input.limit;

      const hits = await hybridSearch(searchArgs);
      await emitAudit({
        action: 'skills.search',
        result: 'success',
        details: { result_count: hits.length },
      });
      return jsonResult({ hits });
    },
  });

  // ── skills.read_resource — read ──────────────────────────────────────────
  registerTool({
    name: 'skills.read_resource',
    description:
      'Read a doc that is attached to a skill as a resource. Verifies the attachment ' +
      "(skill → doc via object_refs role='resource') before fetching the body — defends against id-probing.",
    inputSchema: zodToJsonSchema(SkillsReadResourceInput),
    annotations: {
      title: 'Read skill resource',
      sensitivity: 'read',
      readOnlyHint: true,
      wysiwys: { display_template: 'Read resource {{resource_id}} of skill {{skill_id}}' },
    },
    handler: async (args) => {
      const input = SkillsReadResourceInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      // 1. Verify attachment via object_refs (canonical path).
      const outgoing = await listOutgoingRefs(input.skill_id);
      const attached = outgoing.some(
        (r) => r.toId === input.resource_id && r.role === RESOURCE_ROLE,
      );
      if (!attached) {
        throw errNotFound(
          `resource '${input.resource_id}' not attached to skill '${input.skill_id}'`,
        );
      }

      // 2. Fetch the doc body.
      const { view, body } = await readObject(input.resource_id, { includeBody: true });
      await emitAudit({
        action: 'skills.read_resource',
        resourceId: input.resource_id,
        result: 'success',
        details: { skill_id: input.skill_id },
      });
      const payload = {
        ...view,
        body_b64: body ? Buffer.from(body).toString('base64') : undefined,
      };
      return jsonResult(payload);
    },
  });

  // ── skills.attach_resource — write ───────────────────────────────────────
  registerTool({
    name: 'skills.attach_resource',
    description:
      'Attach a doc as a resource to a skill. Idempotent (re-attach is a no-op). ' +
      "Creates a knowledge-graph ref role='resource' — agent loads the doc together with the skill " +
      '(see objects.get refs.outgoing[]). Use skills.detach_resource to remove.',
    inputSchema: zodToJsonSchema(SkillsAttachResourceInput),
    annotations: {
      title: 'Attach skill resource',
      sensitivity: 'write',
      write: true,
      wysiwys: { display_template: 'Attach doc {{doc_id}} as resource to skill {{skill_id}}' },
    },
    handler: async (args) => {
      const input = SkillsAttachResourceInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      try {
        const r = await addRef({
          fromId: input.skill_id,
          toId: input.doc_id,
          role: RESOURCE_ROLE,
        });
        await emitAudit({
          action: 'skills.attach_resource',
          resourceId: input.skill_id,
          result: 'success',
          details: { doc_id: input.doc_id, warnings: r.warnings.length },
        });
        return jsonResult({ ok: true, warnings: r.warnings });
      } catch (e) {
        await emitAudit({
          action: 'skills.attach_resource',
          resourceId: input.skill_id,
          result: 'error',
          details: { doc_id: input.doc_id },
        });
        throw e;
      }
    },
  });

  // ── skills.detach_resource — write ───────────────────────────────────────
  registerTool({
    name: 'skills.detach_resource',
    description:
      'Remove a resource link from a skill. Idempotent (remove of non-existent ref is a no-op). ' +
      'Does NOT delete the doc — only the knowledge-graph edge. ' +
      'If the doc was attached only to this skill, doc.is_subdoc flips back to false.',
    inputSchema: zodToJsonSchema(SkillsDetachResourceInput),
    annotations: {
      title: 'Detach skill resource',
      sensitivity: 'write',
      write: true,
      wysiwys: { display_template: 'Detach doc {{doc_id}} from skill {{skill_id}}' },
    },
    handler: async (args) => {
      const input = SkillsDetachResourceInput.parse(args);
      const ctx = requireContext();
      if (!ctx.userId) throw errBadRequest('user context required');

      try {
        await removeRef(input.skill_id, input.doc_id, RESOURCE_ROLE);
        await emitAudit({
          action: 'skills.detach_resource',
          resourceId: input.skill_id,
          result: 'success',
          details: { doc_id: input.doc_id },
        });
        return jsonResult({ ok: true });
      } catch (e) {
        await emitAudit({
          action: 'skills.detach_resource',
          resourceId: input.skill_id,
          result: 'error',
          details: { doc_id: input.doc_id },
        });
        throw e;
      }
    },
  });
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function buildSkillMeta(input: {
  groups?: ReadonlyArray<string>;
  resource_ids?: ReadonlyArray<string>;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (input.groups !== undefined) meta['groups'] = [...input.groups];
  // resource_ids wandert NICHT in meta — wir nutzen native object_refs.
  // approval2's Legacy-Pfad ist hier bewusst deprecatet (PLAN-doc-linking P7).
  return meta;
}
