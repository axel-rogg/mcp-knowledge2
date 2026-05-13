// Domain primitives shared across the storage / sharing / search layers.

export type ObjectKind = 'doc' | 'skill' | 'app' | 'memo';

export type Visibility = 'private' | 'shared';

export type SharePermission = 'read' | 'write';

export type SharedResourceKind = 'doc' | 'skill' | 'app';

export type AuthMode = 'jwt' | 'service';

export interface RequestContext {
  /** authenticated user id (UUID) — null only for service-token-internal endpoints */
  userId: string | null;
  /** correlation id propagated across services (UUID) */
  requestId: string;
  authMode: AuthMode;
  /** JWT scopes (e.g. 'docs:write skills:read') — split into array */
  scopes: string[];
}

export interface AuditEventInput {
  action: string;
  resourceKind?: SharedResourceKind | 'memo' | 'upload' | 'system';
  resourceId?: string;
  result: 'success' | 'denied' | 'error';
  details?: Record<string, unknown>;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}
