// AS-3 K10: MCP-protocol types (subset relevant for tool-surfacing).
//
// Spec: Model Context Protocol — Streamable HTTP Transport.

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

export interface InitializeParams {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: { listChanged: boolean };
  };
  serverInfo: { name: string; version: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    sensitivity?: 'read' | 'write' | 'destructive';
    write?: boolean;
    /** approval2 Welle-3 compatibility: when set, approval2's PWA can
     *  render the call before execution. Mustache-style template. */
    wysiwys?: { display_template: string };
  };
}

export interface ListToolsResult {
  tools: ToolDefinition[];
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
    // MCP-Spec 2025-11-25: resource_link is a pointer (uri + name + optional
    // description/mimeType) without the body, ideal for lazy-loaded references.
    // Used by PLAN-document-linking objects.get response.
    | {
        type: 'resource_link';
        uri: string;
        name: string;
        description?: string | undefined;
        mimeType?: string | undefined;
        _meta?: Record<string, unknown> | undefined;
      }
  >;
  isError?: boolean;
  structuredContent?: unknown;
}

export const JSONRPC_ERROR_CODES = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // MCP-specific
  TOOL_NOT_FOUND: -32001,
  TOOL_EXECUTION: -32002,
};
