# ADR 0003 — UUID Object IDs & Unix-ms Timestamps

**Status:** Accepted, 2026-05-13
**Plan reference:** PLAN-architecture-v2 §2.1

## Context

Two schema choices that propagate everywhere:
1. Object identifier type: ULID vs UUID
2. Timestamp storage: `TIMESTAMPTZ` vs `BIGINT` (Unix-ms)

## Decision

- **Object IDs are UUID v4** (random, 128-bit) stored as Postgres `UUID`.
- **Timestamps are `BIGINT` Unix-milliseconds**, not `TIMESTAMPTZ`.

## Rationale

- UUID v4 is unbiased and avoids timing-information leakage that ULIDs
  introduce (lexically-sortable, time-prefixed). For a service that
  encrypts data and is paranoid about side channels, the lack of
  embedded timestamp in the ID is a small but real win.
- Integer-ms timestamps match the wire format that knowledge-core
  (v1, on Cloudflare) used, simplifying any future migration tool.
  They also serialise without timezone surprises in JSON.

## Consequences

- All Postgres time math uses `EXTRACT(epoch FROM now()) * 1000` to
  produce a ms-value (see RLS policy in `0001_rls.sql`).
- ULIDs remain available via `ulidx` for non-persistent correlation
  identifiers if ever needed.
- Code using `Date` does explicit `Date.now()` / `new Date(msValue)`
  conversions at API boundaries; no `Date` objects in DB rows.

## Alternatives considered

- ULID: rejected for the reasons above; also drizzle-orm has no
  first-class ULID column type — would have needed a custom type
  wrapper.
- `TIMESTAMPTZ`: rejected for cross-system compatibility with the
  Cloudflare-based v1 predecessor and to keep JSON serialisation
  unambiguous.
