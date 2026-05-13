# ADR 0002 — Postgres RLS as the User-Isolation Boundary

**Status:** Accepted, 2026-05-13
**Plan reference:** PLAN-architecture-v2 §2.2

## Context

Multi-user storage with per-object sharing demands an isolation
mechanism that survives a buggy application. Options:

- Application-layer filtering only (`WHERE owner_id = $1` in every
  query)
- Postgres Row-Level-Security (RLS)
- A separate per-user database/schema

## Decision

Postgres RLS, with `app.current_user` set via `SET LOCAL` inside each
request's transaction. The application role (`knowledge_app`) does **not**
have `BYPASSRLS`.

## Rationale

- Application-layer filtering alone is a single point of failure: one
  missing `WHERE` clause → cross-user leak. RLS makes such a bug
  invisible at the data layer.
- Per-user schemas explode operationally — every migration runs N
  times, monitoring multiplies, restore-per-tenant becomes the default
  rather than the exception.
- RLS is well understood, performant when indexes are aligned with the
  policy predicates, and integrates cleanly with the share-grants table
  via subquery.

## Consequences

- Every request handler must enter a transaction via `withUserTx` to
  set the `app.current_user` setting.
- Admin actions that need to cross users (e.g., `erase-user`) use a
  separate role (`knowledge_admin`) with `BYPASSRLS`, exposed only via
  internal endpoints with service-token authentication.
- Tests must exercise RLS specifically — see
  `tests/integration/rls.test.ts`.
- Performance: the share-grants subquery in the visibility policy must
  be indexed (`idx_grants_lookup ON share_grants(granted_to, revoked_at)`).
