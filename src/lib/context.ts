import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from '../types/domain.ts';

const store = new AsyncLocalStorage<RequestContext>();

export function withContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return store.getStore();
}

export function requireContext(): RequestContext {
  const ctx = store.getStore();
  if (!ctx) throw new Error('request context not initialised');
  return ctx;
}

export function requireUserId(): string {
  const ctx = requireContext();
  if (!ctx.userId) {
    throw new Error('user id not present in context (service-token route?)');
  }
  return ctx.userId;
}
