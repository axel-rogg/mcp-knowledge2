// Domain primitives shared across the storage / sharing / search layers.

export type ObjectKind = 'doc' | 'skill' | 'app' | 'memo';

export type Visibility = 'private' | 'shared';

export type SharePermission = 'read' | 'write';

export type SharedResourceKind = 'doc' | 'skill' | 'app';

export type AuthMode = 'jwt' | 'service' | 'on_behalf_of';

export interface RequestContext {
  /** authenticated user id (UUID) — null only for service-token-internal endpoints */
  userId: string | null;
  /** correlation id propagated across services (UUID) */
  requestId: string;
  authMode: AuthMode;
  /** JWT scopes (e.g. 'docs:write skills:read') — split into array */
  scopes: string[];
  /** AS-3 K12: true when authenticated via approval2 OBO pattern */
  viaProxy?: boolean;
  /** AS-3 K12: approval_id passed in OBO-JWT (writes require, reads may omit per K-D4) */
  approvalId?: string;
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
