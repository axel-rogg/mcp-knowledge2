// Sanity tests for the 7 wrapper-migration approval2-Compat fixes.
//
// These run against the static registry (no DB). They validate JSON-Schemas
// + annotations produced by registerAllTools(). For runtime-behaviour
// validation (cursor-alias-dual-emit, memorize hits+items dual-output)
// rely on integration tests with a live DB — the sanity layer here ensures
// the schema-shape contracts hold so the wrapper doesn't drift again.

import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllTools } from '../../src/mcp/register_tools.ts';
import { getRegisteredTools, resetToolsForTest } from '../../src/mcp/tools.ts';
import type { ToolDefinition } from '../../src/mcp/types.ts';

let toolsByName: Map<string, ToolDefinition>;

beforeAll(() => {
  resetToolsForTest();
  registerAllTools();
  toolsByName = new Map(getRegisteredTools().map((t) => [t.name, t]));
});

describe('approval2-Compat: objects.browse_read id-schema relaxed', () => {
  it('id is plain string (no UUID format constraint)', () => {
    const tool = toolsByName.get('objects.browse_read');
    expect(tool, 'objects.browse_read registered').toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, { type?: unknown; format?: string }> }).properties;
    expect(props['id']?.type).toBe('string');
    // local zodToJsonSchema doesn't emit `format` at all today; this
    // assertion future-proofs against someone re-tightening to UUID.
    expect(props['id']?.format).toBeUndefined();
  });
});

describe('approval2-Compat: sensitivity destructive→danger', () => {
  it('objects.delete, objects.remove_ref, shares.revoke all use "danger"', () => {
    const targets = ['objects.delete', 'objects.remove_ref', 'shares.revoke'];
    for (const name of targets) {
      const tool = toolsByName.get(name);
      expect(tool, `${name} registered`).toBeDefined();
      const annotations = (tool!.annotations as Record<string, unknown>) ?? {};
      expect(annotations['sensitivity'], `${name} sensitivity`).toBe('danger');
    }
  });

  it('no tool still uses sensitivity="destructive"', () => {
    const all = getRegisteredTools();
    const offenders = all.filter((t) => {
      const annotations = (t.annotations as Record<string, unknown>) ?? {};
      return annotations['sensitivity'] === 'destructive';
    });
    expect(offenders.map((t) => t.name)).toEqual([]);
  });
});

describe('approval2-Compat: notes.update description nullable', () => {
  it('description accepts null', () => {
    const tool = toolsByName.get('notes.update');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, { type?: unknown }> }).properties;
    const desc = props['description'];
    expect(desc).toBeDefined();
    // ZodNullable emits type: [innerType, 'null'] via our local converter.
    const t = desc!['type'];
    expect(Array.isArray(t)).toBe(true);
    expect(t as unknown[]).toContain('null');
    expect(t as unknown[]).toContain('string');
  });

  it('description is still optional (not in required[])', () => {
    const tool = toolsByName.get('notes.update');
    const schema = tool!.inputSchema as { required?: string[] };
    expect(schema.required ?? []).not.toContain('description');
  });
});

describe('approval2-Compat: cursor alias schema-level', () => {
  it('objects.browse_list still takes `cursor` (snake_case input)', () => {
    const tool = toolsByName.get('objects.browse_list');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['cursor']).toBeDefined();
  });

  it('lists.list still takes `cursor` (snake_case input)', () => {
    const tool = toolsByName.get('lists.list');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['cursor']).toBeDefined();
  });
});

// Note: cursor-Alias-Output (nextCursor+next_cursor), memorize.search-Output
// (hits+items), docs.usages title/subtype-Enrichment and skills.put
// lazy-migration of meta.resource_ids[] all require a live DB to verify.
// They have unit-test-coverage via the integration suite that runs in CI
// against a Neon test-branch.
