// AS-3 K10: MCP server (Streamable-HTTP transport).
//
// Spec: PLAN-as3-autonomous.md §1.4 + MCP Streamable-HTTP transport doc.
//
// Single endpoint: POST /mcp. Auth: same multi-issuer / OBO middleware
// stack as /v1/* — JWT or OBO, no DCR-OAuth-specific surface (DCR happens
// once via /oauth/register, then clients reach /mcp with a Bearer token).
//
// Tools are registered from src/mcp/tools.ts (K11).

import { Hono } from 'hono';
import { logger } from '../lib/logger.ts';
import { requireJwtOrOnBehalfOf } from '../auth/require_jwt_or_obo.ts';
import { installContext } from '../middleware/context.ts';
import { errBadRequest } from '../lib/errors.ts';
import { currentContext } from '../lib/context.ts';
import {
  JSONRPC_ERROR_CODES,
  MCP_PROTOCOL_VERSION,
  type CallToolParams,
  type CallToolResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ListToolsResult,
  type ToolDefinition,
} from './types.ts';
import { getRegisteredTools, runRegisteredTool } from './tools.ts';
import { acceptHeaderOk, handleRpcBody, ok, rpcErr } from './transport.ts';

const SERVER_INFO = { name: 'mcp-knowledge2', version: '0.1.0' };

// Methods allowed under authMode='service' (S2S-Discovery via Bearer
// SERVICE_TOKEN — siehe auth/require_jwt_or_obo.ts). tools/call ist
// explizit ausgeschlossen: alle write/read-Tool-Aufrufe brauchen einen
// User-Context (JWT oder OBO).
const SERVICE_MODE_ALLOWED_METHODS = new Set([
  'initialize',
  'initialized',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
]);

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  // Service-Mode-Enforcement: bearer-SERVICE_TOKEN-Caller dürfen NUR Discovery.
  const ctx = currentContext();
  if (ctx?.authMode === 'service' && !SERVICE_MODE_ALLOWED_METHODS.has(req.method)) {
    return rpcErr(
      id,
      JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
      `method '${req.method}' not allowed under service-token auth (use OBO or user JWT)`,
    );
  }
  try {
    switch (req.method) {
      case 'initialize': {
        const p = (req.params ?? {}) as InitializeParams;
        const result: InitializeResult = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        };
        void p;
        return ok(id, result);
      }
      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok(id, {});
      case 'tools/list': {
        const tools = getRegisteredTools().map<ToolDefinition>((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }));
        const result: ListToolsResult = { tools };
        return ok(id, result);
      }
      case 'tools/call': {
        const params = (req.params ?? {}) as CallToolParams;
        if (typeof params.name !== 'string' || params.name.length === 0) {
          return rpcErr(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'tools/call: name required');
        }
        try {
          const result: CallToolResult = await runRegisteredTool(params.name, params.arguments ?? {});
          return ok(id, result);
        } catch (e) {
          const msg = (e as Error).message ?? 'tool execution failed';
          if ((e as { code?: number }).code === JSONRPC_ERROR_CODES.TOOL_NOT_FOUND) {
            return rpcErr(id, JSONRPC_ERROR_CODES.TOOL_NOT_FOUND, msg);
          }
          logger.warn({ err: e, tool: params.name }, 'tool execution failed');
          return rpcErr(id, JSONRPC_ERROR_CODES.TOOL_EXECUTION, msg);
        }
      }
      default:
        if (isNotification) return null;
        return rpcErr(id, JSONRPC_ERROR_CODES.METHOD_NOT_FOUND, `unsupported method ${req.method}`);
    }
  } catch (e) {
    logger.error({ err: e, method: req.method }, 'mcp dispatch failed');
    return rpcErr(id, JSONRPC_ERROR_CODES.INTERNAL, (e as Error).message ?? 'internal error');
  }
}

export const mcpRouter = new Hono();

// MCP Streamable-HTTP: same auth stack as /v1/*. JWT or OBO accepted.
mcpRouter.use('/mcp', requireJwtOrOnBehalfOf, installContext);

mcpRouter.post('/mcp', async (c) => {
  if (!acceptHeaderOk(c.req.header('accept'))) {
    throw errBadRequest('Accept must include application/json');
  }
  const raw = await c.req.json().catch(() => null);
  const handled = await handleRpcBody(raw, dispatch);
  if (handled.body === null) return c.body(null, handled.status as 200 | 202 | 400);
  return c.json(handled.body, handled.status as 200 | 400);
});
