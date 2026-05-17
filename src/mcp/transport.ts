// AS-3 K10: Streamable-HTTP transport adapter.
//
// Spec: PLAN-as3-autonomous.md §1.4.
//
// MCP-Streamable-HTTP-Transport is a JSON-RPC-over-HTTP profile: clients
// POST one or many JSON-RPC requests, server may respond with JSON (single
// request/response) or text/event-stream (server-to-client streaming).
//
// This file centralises the parse / batch / dispatch glue so server.ts
// stays narrow.

import { z } from 'zod';
import { logger } from '../lib/logger.ts';
import {
  JSONRPC_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcSuccess,
} from './types.ts';

const JsonRpcReq = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export function ok<R>(id: string | number | null, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: '2.0', id, result };
}
export function rpcErr(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export type Dispatcher = (req: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

export interface HandleResult {
  status: number;
  body: JsonRpcResponse | JsonRpcResponse[] | null;
}

/**
 * Handle one Streamable-HTTP request body. Returns either a single response,
 * a batch of responses, or null (when the request was a notification).
 */
export async function handleRpcBody(raw: unknown, dispatch: Dispatcher): Promise<HandleResult> {
  if (raw === null || raw === undefined) {
    return { status: 400, body: rpcErr(null, JSONRPC_ERROR_CODES.PARSE, 'invalid JSON') };
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { status: 400, body: rpcErr(null, JSONRPC_ERROR_CODES.INVALID_REQUEST, 'empty batch') };
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of raw) {
      const parsed = JsonRpcReq.safeParse(item);
      if (!parsed.success) {
        responses.push(rpcErr(null, JSONRPC_ERROR_CODES.INVALID_REQUEST, 'invalid request'));
        continue;
      }
      try {
        const out = await dispatch(parsed.data as JsonRpcRequest);
        if (out) responses.push(out);
      } catch (e) {
        logger.error({ err: e }, 'mcp transport dispatch threw');
        responses.push(rpcErr(parsed.data.id ?? null, JSONRPC_ERROR_CODES.INTERNAL, (e as Error).message));
      }
    }
    return { status: 200, body: responses };
  }
  const parsed = JsonRpcReq.safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: rpcErr(null, JSONRPC_ERROR_CODES.INVALID_REQUEST, 'invalid request') };
  }
  try {
    const out = await dispatch(parsed.data as JsonRpcRequest);
    if (!out) return { status: 202, body: null };
    return { status: 200, body: out };
  } catch (e) {
    logger.error({ err: e }, 'mcp transport dispatch threw');
    return {
      status: 200,
      body: rpcErr(parsed.data.id ?? null, JSONRPC_ERROR_CODES.INTERNAL, (e as Error).message),
    };
  }
}

/**
 * MCP-Streamable-HTTP Accept-header policy. The spec requires clients to
 * advertise both application/json AND text/event-stream so the server can
 * stream. We currently only respond with JSON, but we reject clients that
 * don't allow JSON at all so misconfigured clients fail loud.
 */
export function acceptHeaderOk(accept: string | undefined): boolean {
  if (!accept) return true;
  const a = accept.toLowerCase();
  return a.includes('application/json') || a.includes('*/*');
}
