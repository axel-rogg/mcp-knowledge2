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


## Appendix — 2026-05-19: Convenience-Layer als Tool-Schicht

**Update**: Tool-Wrapper-Migration aus mcp-approval2 nach KC2 (Plan-File
[PLAN-tool-surface-as-storage-canonical.md](../plans/active/PLAN-tool-surface-as-storage-canonical.md))
fügt KC2 eine zweite Tool-Ebene hinzu:

1. **Generic Primitives** (16 Tools, `tags:['low-level']`): `objects.*`,
   `shares.*`, `uploads.*` — direkt auf storage-Layer, subtype-agnostisch
   wie ADR vorsieht.

2. **Subtype-aware Convenience-Tools** (47 Tools, neu in KC2): `docs.put`,
   `lists.create`, `notes.update`, `groups.*`, `memorize.add` etc. —
   user-friendly Surface die intern `createObject({subtype:'doc', ...})`
   ruft.

**Wichtig: ADR-0004 bleibt eingehalten.** Die **Daten-Schicht** ist weiter
generic — `objects` Tabelle hat `subtype: string`, kein Enum, kein
discriminated-Schema. Subtype-Awareness lebt **nur in der Tool-Schicht**
(`src/mcp/tools/<family>.ts`).

Begründung Convenience-Layer:
- MCP-Clients (Claude.ai) brauchen User-friendly Tool-Names wie
  `docs.put({title, body})` statt `objects.create({subtype:'doc', title,
  body_b64, ...})`. Convenience-Tools sind dünne Wrapper, kein
  zusätzlicher Daten-Layer.
- Sub-Tool-Files (`src/mcp/tools/<family>.ts`) sind 1:1 äquivalent zu
  den hardcoded approval2-Wrappers vor Cutover — Schema, Sensitivity,
  display_template aus dem alten approval2-Hub portiert.
- Cross-Repo Single-Source-of-Truth: approval2 sieht die Tools jetzt
  via Auto-Forwarder als kanonisch von KC2. Schema-Drift unmöglich.

Neue Subtypes in der Tool-Schicht (Phase 1 der Migration): `doc`,
`skill_manifest`, `memo`, `list`, `note`, `group`. Storage-Layer bleibt
unverändert generic — keine Migration nötig.
