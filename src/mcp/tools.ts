// AS-3 K10/K11: MCP tool registry.
//
// Spec: PLAN-as3-autonomous.md §1.4.
//
// K10 introduces the registry shape; K11 populates it with the REST-wrapped
// surface (objects.*, search, shares.*, uploads.*) with display_template
// annotations so approval2 can render them.

import type { CallToolResult, ToolDefinition } from './types.ts';
import { JSONRPC_ERROR_CODES } from './types.ts';

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export interface RegisteredTool extends ToolDefinition {
  handler: ToolHandler;
}

const registry: Map<string, RegisteredTool> = new Map();

export function registerTool(def: RegisteredTool): void {
  if (registry.has(def.name)) {
    throw new Error(`duplicate tool registration: ${def.name}`);
  }
  registry.set(def.name, def);
}

export function getRegisteredTools(): ToolDefinition[] {
  return Array.from(registry.values()).map(({ handler: _h, ...t }) => {
    void _h;
    return t;
  });
}

export async function runRegisteredTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    const e = new Error(`tool not registered: ${name}`) as Error & { code: number };
    e.code = JSONRPC_ERROR_CODES.TOOL_NOT_FOUND;
    throw e;
  }
  return tool.handler(args);
}

export function resetToolsForTest(): void {
  registry.clear();
}

/**
 * Append a tag to a registered tool's annotations.tags (idempotent — duplicate
 * tags are skipped). Used to mark Low-Level-Tools after their registration so
 * the approval2-Auto-Forwarder can filter them via tags-check.
 *
 * Throws if the tool is not registered yet (caller order error).
 */
export function addAnnotationTag(toolName: string, tag: string): void {
  const t = registry.get(toolName);
  if (!t) throw new Error(`addAnnotationTag: tool not registered: ${toolName}`);
  const annotations = (t.annotations ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(annotations['tags']) ? (annotations['tags'] as string[]) : [];
  if (existing.includes(tag)) return;
  const nextTags = [...existing, tag];
  registry.set(toolName, {
    ...t,
    annotations: { ...annotations, tags: nextTags } as typeof t.annotations,
  });
}
