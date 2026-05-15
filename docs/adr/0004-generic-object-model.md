# ADR 0004 — Generic Object Model (no kind discriminator)

**Status:** Accepted, 2026-05-15
**Plan reference:** PLAN-architecture-v2 §§ 2.1 + 3.5 + 5.2-5.4 (revised v3)
**Implementation brief:** GENERIC-DATA-MODEL.md v3

## Context

mcp-knowledge2 had 4 hardcoded ObjectKinds (`doc | skill | app | memo`)
backed by CHECK constraints, Drizzle types, AAD format, and zod enums.
Sharing, RLS, encryption and search were already kind-agnostic in
behaviour — only the discriminator was hardcoded.

User-Direktive 2026-05-15:
- "Es gibt nur einen generischen Dokumenttyp."
- "Es reicht ein Datentyp der alles kann. Die anderen sind nur Wrapper."

## Decision

Remove `kind` column from `objects`, `share_grants.resource_kind`,
`audit_log.resource_kind`, `ObjectKind` + `SharedResourceKind` types,
`<kind>:<subtype>` from AAD format (AAD becomes
`<recordType>|<owner_id>|<object_id>`). `subtype` remains as free-form
optional string column without DB-enforcement.

Embedding rule is uniform: `description != null AND request.embed == true`
→ `composeEmbedSource(title, description, triggerHints, keywords)` →
upsert in `object_vectors`. No per-subtype defaults, no
`searchable_vector` property, no incompatibility matrix.

Memo-Sharing-Restriction (heute `if (obj.kind === 'memo') throw` in
`shares.ts:49`) entfällt — alle Subtypes uniform shareable.

Domain logic (body-format validation, mutation pattern, decay score,
property incompatibilities, "memo nicht shareable in App-X"-Policies)
lives in caller-side tool wrappers (`lists.*`, `notes.*`, `memorize.*`
in mcp-approval2), not in storage.

## Rationale

- Storage layer was always uniform; kind was conventional bundling
- Sharing-Generizität: memos are now shareable like everything else
- New subtypes (e.g., 'list', 'note') no longer require schema migrations
- AAD simpler, fewer migration surfaces for future format-changes
- Title + description columns already exist and are uniformly FTS-indexed
- composeEmbedSource is already kind-agnostic in code — brief codifies real behavior

## Consequences

- AAD format breaks all existing ciphertexts — pre-pilot, no data lost
- Cross-Service-Contract change: mcp-approval2 (22 src + 9 test files, ~125 lines)
  must drop kind-typed scopes + adapter + apps-subsystem discriminator-design
  (see §11 in GENERIC-DATA-MODEL.md v3)
- Apps-Subsystem in mcp-approval2 uses two-level `kind='app' + subtype=appType`
  hierarchy (apps/api.ts:230-353) — needs new discriminator design
- Memo-Sharing-Restriction lost — wrapper enforced if needed
- Type-safety on subtype is application-layer (zod string validation), not DB-enforced
- Storage gives zero body-format guarantees — wrappers own that

## Alternatives Considered

- Soften kind enum to free-form string: rejected as semantic noise
- Keep kind as bundle tag: rejected — code would have to handle "kind exists but is meaningless"
- Keep per-subtype Property-Defaults (`searchable_vector`, `decay_enabled`,
  `mutation_pattern`) in storage: rejected — these are wrapper concerns
- Keep `subtype` in AAD as `<recordType>|<owner>|<object>|<subtype>`:
  rejected — subtype is freeform caller-convention, owner_id+object_id
  sufficient for replay-protection
- Keep `audit_log.resource_kind` as nullable TEXT: rejected as default —
  audit_log details_json reicht; see §6.4 of brief for opt-in alternative
