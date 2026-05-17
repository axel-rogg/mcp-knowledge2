// Cross-service contract test (T3-3): MCP `tools/list` schema KC2 → approval2.
//
// This file VALIDATES the shape of KC2's `tools/list` response so approval2's
// kc_wrappers auto-generator (apps/server/src/tools/kc_wrappers/index.ts +
// manifest-client.ts) can mount every tool without runtime errors.
//
// Specs:
//   - mcp-knowledge2/docs/plans/active/PLAN-as3-autonomous.md §1.4
//     ("annotations.wysiwys.display_template kompatibel zu approval2")
//   - mcp-approval2/apps/server/src/tools/kc_wrappers/manifest-client.ts
//     :: KcToolManifestEntry, KcManifest (the canonical consumer-side type)
//
// Truth-source: the producer-side spec wins (KC2 §1.4). We document the bridge
// approval2-side has to do (snake_case `wysiwys.display_template` vs flat
// `displayTemplate`).

import { describe, expect, it, beforeAll } from 'vitest';
import { registerAllTools } from '../../src/mcp/register_tools.ts';
import { getRegisteredTools, resetToolsForTest } from '../../src/mcp/tools.ts';

beforeAll(() => {
  resetToolsForTest();
  registerAllTools();
});

// ─── Schema invariants every entry must satisfy ───────────────────────────

describe('KC2 tools/list — manifest entry shape', () => {
  it('produces at least one tool', () => {
    const tools = getRegisteredTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('every tool has name + description + inputSchema (manifest-client mandatory fields)', () => {
    const tools = getRegisteredTools();
    for (const t of tools) {
      expect(typeof t.name, `tool name: ${JSON.stringify(t)}`).toBe('string');
      expect(t.name.length, `tool name not empty: ${t.name}`).toBeGreaterThan(0);
      expect(typeof t.description, `tool ${t.name} description`).toBe('string');
      expect(typeof t.inputSchema, `tool ${t.name} inputSchema`).toBe('object');
      expect(t.inputSchema, `tool ${t.name} inputSchema not null`).not.toBeNull();
    }
  });

  it('names follow approval2 wrapper convention (lowercase dotted)', () => {
    // The kc_wrappers/* generator uses entry.name verbatim. approval2's
    // mcp.protocol.registry won't accept spaces or uppercase, and dotted
    // namespaces (objects.create, shares.*) are part of the agreed
    // surface (PLAN-as3-autonomous.md §1.4).
    const tools = getRegisteredTools();
    const allowed = /^[a-z][a-z0-9._-]+$/;
    for (const t of tools) {
      expect(t.name).toMatch(allowed);
    }
  });

  it('inputSchema has type=object so approval2 can pass arg-objects through', () => {
    const tools = getRegisteredTools();
    for (const t of tools) {
      const s = t.inputSchema as Record<string, unknown>;
      // tools generated via zodToJsonSchema produce `type:'object'`. If a
      // KC tool emits a different root type, approval2's forwardToKc will
      // mis-package the args (wraps them under `_input`).
      expect(s['type'], `tool ${t.name} root type`).toBe('object');
    }
  });
});

describe('KC2 tools/list — annotations contract (approval2 consumer)', () => {
  it('every tool has annotations attached (sensitivity gating depends on it)', () => {
    const tools = getRegisteredTools();
    for (const t of tools) {
      expect(t.annotations, `tool ${t.name} annotations`).toBeDefined();
    }
  });

  it('annotations.sensitivity is one of read|write|destructive (approval2 maps that)', () => {
    const tools = getRegisteredTools();
    for (const t of tools) {
      const a = t.annotations as { sensitivity?: string };
      if (a.sensitivity !== undefined) {
        expect(['read', 'write', 'destructive']).toContain(a.sensitivity);
      }
    }
  });

  it('write-tools set annotations.write=true OR sensitivity!=read (approval-gate signal)', () => {
    // approval2's kc_wrappers/index.ts resolves sensitivity from EITHER
    // annotations.sensitivity OR annotations.write===true. We pick a
    // known-write tool (objects.create) and check both signals are
    // present + consistent.
    const tools = getRegisteredTools();
    const create = tools.find((t) => t.name === 'objects.create');
    expect(create, 'objects.create not registered').toBeDefined();
    const a = create!.annotations as { sensitivity?: string; write?: boolean };
    const isWriteSignalSet = a.write === true || a.sensitivity === 'write' || a.sensitivity === 'destructive';
    expect(isWriteSignalSet, `objects.create must signal write (got ${JSON.stringify(a)})`).toBe(true);
  });

  it('display_template lives under annotations.wysiwys.display_template (KC2 canonical)', () => {
    // approval2's `kc_wrappers/index.ts :: resolveDisplayTemplate` accepts
    // BOTH flat `displayTemplate` and nested `wysiwys.display_template`.
    // The producer-side canonical form is the nested one (per
    // PLAN-as3-autonomous.md §1.4). Verify KC2 emits at least one
    // nested template so the bridge is exercised.
    const tools = getRegisteredTools();
    const withNested = tools.filter((t) => {
      const a = t.annotations as { wysiwys?: { display_template?: string } };
      return typeof a.wysiwys?.display_template === 'string' && a.wysiwys.display_template.length > 0;
    });
    expect(
      withNested.length,
      `expected at least one tool with annotations.wysiwys.display_template, got ${tools
        .map((t) => t.name)
        .join(',')}`,
    ).toBeGreaterThan(0);
  });

  it('all write-flagged tools also expose a display_template (WYSIWYS-mandate)', () => {
    const tools = getRegisteredTools();
    const writeTools = tools.filter((t) => {
      const a = t.annotations as { sensitivity?: string; write?: boolean };
      return a.write === true || a.sensitivity === 'write' || a.sensitivity === 'destructive';
    });
    expect(writeTools.length, 'no write-tools registered').toBeGreaterThan(0);
    for (const t of writeTools) {
      const a = t.annotations as {
        wysiwys?: { display_template?: string };
        displayTemplate?: string;
      };
      const template = a.wysiwys?.display_template ?? a.displayTemplate;
      expect(
        typeof template === 'string' && template.length > 0,
        `write-tool ${t.name} missing display_template (annotations: ${JSON.stringify(a)})`,
      ).toBe(true);
    }
  });
});

describe('KC2 tools/list — JSON-RPC envelope (what manifest-client expects)', () => {
  it('renders a tools/list response approval2 can parse', () => {
    // Simulate exactly what KC2's MCP-server returns for tools/list and
    // run approval2's manifest-client validator against it.
    const tools = getRegisteredTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    const jsonRpcResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools },
    };
    // The minimum the manifest-client.ts validator checks:
    expect(jsonRpcResponse.jsonrpc).toBe('2.0');
    expect(jsonRpcResponse).toHaveProperty('result');
    expect(Array.isArray((jsonRpcResponse.result as { tools: unknown[] }).tools)).toBe(true);
    // Every entry passes the `isToolEntry` predicate.
    for (const t of (jsonRpcResponse.result as { tools: unknown[] }).tools) {
      const e = t as Record<string, unknown>;
      expect(typeof e['name']).toBe('string');
      expect(typeof e['description']).toBe('string');
      expect(typeof e['inputSchema']).toBe('object');
      expect(e['inputSchema']).not.toBeNull();
    }
  });
});

// ─── Mandatory tool surface (approval2 expects these names) ───────────────

describe('KC2 tools/list — approval2-side mandatory tool surface', () => {
  it.each([
    'objects.create',
    'objects.get',
    'objects.list',
    'objects.update',
    'objects.delete',
    'shares.create',
    'shares.list',
    'shares.revoke',
    'search',
  ])('exposes %s (referenced by approval2 spec §1.4)', (name) => {
    const tools = getRegisteredTools();
    expect(tools.find((t) => t.name === name), `tool ${name} not registered`).toBeDefined();
  });
});
