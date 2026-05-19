# PLAN — KC2 als Tool-Surface-Owner (Wrapper-Migration aus approval2)

> **Status: ✅ COMPLETE — alle Phasen LIVE (2026-05-18/19)**
>
> KC2-Side Commits:
> - 47 Tool-Files (notes/lists/memorize/docs/skills/groups/sharing/objects-browse): [123a94f](https://github.com/axel-rogg/mcp-knowledge2/commit/123a94f) (pilot) + [b1e44e0](https://github.com/axel-rogg/mcp-knowledge2/commit/b1e44e0) (Rest) + [1c0420a](https://github.com/axel-rogg/mcp-knowledge2/commit/1c0420a) (tags + sanity)
> - OBO-Service-Token-Bypass für tools/list-Discovery: [9296e74](https://github.com/axel-rogg/mcp-knowledge2/commit/9296e74)
> - 7 must-fix-Items vor approval2-Cleanup: [4bf4ce5](https://github.com/axel-rogg/mcp-knowledge2/commit/4bf4ce5)
>
> approval2-Side: hardcoded Wrappers in `apps/server/src/_to_delete/2026-05-19/wrappers/` soft-deleted, Feature-Flag `WRAPPER_SOURCE` 2026-05-19 entfernt.
>
> Cross-Repo-Partner: [mcp-approval2/docs/plans/active/PLAN-tool-surface-cleanup.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-tool-surface-cleanup.md)
>
> **Ziel**: Alle 48 High-Level-Subtype-Wrappers von approval2 nach KC2 migrieren. KC2 bekommt die "User-Surface", approval2 wird zum reinen MCP-Facade + Approval-Hub mit Auto-Forwarder zu KC2.
>
> **User-Decision (2026-05-18)**: Komplette Migration, keine einzige Ausnahme. Direkt auf `main` mit Feature-Flag `WRAPPER_SOURCE=hardcoded|kc2|both`.

## §1 Architektur-Ausgangspunkt

KC2 hat heute **16 MCP-Tools** ([src/mcp/register_tools.ts](src/mcp/register_tools.ts)):
- `objects.*` (9): create, get, list, update, delete, restore, usages, add_ref, remove_ref
- `shares.*` (4): create, list, revoke, shared_with_me
- `uploads.*` (3): init, complete, status

Alle low-level, generic-object (ADR-0004). User-friendly High-Level-Tools (`docs.put`, `lists.create`, ...) gibt es heute **NICHT** in KC2 — sie leben als hardcoded Wrapper in approval2.

**Diese Migration**: 48 neue Tool-Files in KC2 erstellen, die intern die bestehenden Service-Methoden (`createObject({subtype: 'doc', ...})`) aufrufen. KC2's Daten-Schicht bleibt generic.

## §2 Tool-Inventar mit Detail-Spec

### §2.1 docs.* — 7 Tools, subtype `doc`

| Tool | Sensitivity | displayTemplate | Body-Encoding | Service-Method |
|---|---|---|---|---|
| `docs.put` | write | "Create/Update document: {{filename}}" | Inline ≤16KB → `body_inline`; >16KB → R2 unter `objects/<ulid>`. AAD = `objects\|<id>\|doc:<ulid>`. Binary via Base64. | `createObject` / `updateObject` (subtype: 'doc') |
| `docs.get` | read | — | Inline-Body direkt, R2-Body via `expandBody: true` | `getObject` |
| `docs.list` | read | — | Body-truncated, optional `embedded_only`/`without_embedding` Filter | `listObjects({subtype:'doc'})` |
| `docs.delete` | danger | "DELETE document {{id}}{{#force}} (force){{/force}}" | refcount-aware soft-delete; `force=true` für refcount>0 | `deleteObject` |
| `docs.usages` | read | — | Liste incoming `object_refs` mit Role 'skill_resource' | `listIncomingRefs` |
| `docs.attach_to` | write | "Attach doc {{doc_id}} to skills: {{skill_ids}}" | Batch-Add von object_refs (multi-skill ein Approval) | `addObjectRef` × N |
| `docs.update_summary` | write | "Update summary for doc {{id}} ({{summary.length}} chars)" | Encrypted summary in `description_enc` BLOB + re-embed in Vectorize | `updateObject` + `embedDocument` |

**Special**: `docs.put` body-encoding ist heute in approval2 in [docs-tools.ts:60-150](https://github.com/axel-rogg/mcp-approval2/blob/main/apps/server/src/tools/docs-tools.ts). KC2 hat in [src/services/objects.ts] schon ähnliche Body-Routing-Logic — `docs.put` wird ein dünner Wrapper.

### §2.2 skills.* — 9 Tools, subtype `skill_manifest`

| Tool | Sensitivity | displayTemplate | Body-Encoding | Service-Method |
|---|---|---|---|---|
| `skills.put` | write | "Create/Update skill: {{title}}" | Manifest-MD + YAML-Frontmatter, Resource-Refs via `object_refs(role='skill_resource')` | `createObject` / `updateObject` |
| `skills.get` | read | — | Manifest-Body | `getObject` |
| `skills.get_bundle` | read | — | Manifest + alle ge-attachten Resources (eager) | `getObjectWithRefs` |
| `skills.list` | read | — | Body-truncated | `listObjects({subtype:'skill_manifest'})` |
| `skills.delete` | danger | "DELETE skill {{id}}{{#force}} (force){{/force}}" | refcount-aware | `deleteObject` |
| `skills.search` | read | — | FTS5 + Vectorize hybrid, RRF-fused | `hybridSearch({subtype:'skill_manifest'})` |
| `skills.read_resource` | read | — | Body eines Resources via ref | `getObject(refTarget)` |
| `skills.attach_resource` | write | "Attach resource {{resource_id}} to skill {{skill_id}}" | Single-ref-add | `addObjectRef` |
| `skills.detach_resource` | write | "Detach resource {{resource_id}} from skill {{skill_id}}" | Single-ref-remove | `removeObjectRef` |

**Manifest-Parser-Risiko**: YAML-Frontmatter-Parsing ist heute in approval2. KC2 braucht den Parser. Empfehlung: shared in `packages/core/src/skills/manifest.ts` (eigenes npm-Workspace-Package, cross-repo nutzbar) ODER duplizieren. **Phase 1 Decision**: duplizieren, später konsolidieren.

### §2.3 memorize.* — 4 Tools, subtype `memo`

| Tool | Sensitivity | displayTemplate | Body-Encoding | Service-Method |
|---|---|---|---|---|
| `memorize.add` | write | "Memorize: {{body}}" (truncated 80 chars) | Plain-text + Vectorize-Embed (bge-m3 multilingual) | `createObject` + `embedMemo` |
| `memorize.search` | read | — | Vectorize-Query + Time-Decay-Score (half-life 90d) | `vectorSearchWithDecay` |
| `memorize.list_recent` | read | — | Top-N by created_at | `listObjects({subtype:'memo', orderBy:'created_at desc'})` |
| `memorize.delete` | danger | "FORGET memo {{id}}" | hard-delete (kein Refcount möglich, memos sind atomar) | `deleteObject` |

### §2.4 lists.* — 6 Tools, subtype `list`

| Tool | Sensitivity | displayTemplate | Body-Encoding | Service-Method |
|---|---|---|---|---|
| `lists.create` | write | "Create list: {{title}}" | Markdown mit `- [ ] item`-Format | `createObject({subtype:'list'})` |
| `lists.add_item` | write | "Add item to {{list_id}}: {{text}}" | Append `- [ ] {{text}}` zur body-Markdown | `updateObject` mit body-patch |
| `lists.tick` | write | "Tick item in {{list_id}}: {{match}}" | Find-by-text oder line-index, `[ ]` → `[x]` | `updateObject` |
| `lists.untick` | write | "Untick item in {{list_id}}: {{match}}" | `[x]` → `[ ]` | `updateObject` |
| `lists.list` | read | — | Body-truncated | `listObjects({subtype:'list'})` |
| `lists.get` | read | — | Full markdown + parsed items | `getObject` + parser |

**Checkbox-Toggle-Logic** (`lists.tick/untick`): heute in approval2's `lists-tools.ts`. Reine String-Manipulation, kein State-Risiko. Tests aus approval2 mit-migrieren.

### §2.5 notes.* — 5 Tools, subtype `note`

| Tool | Sensitivity | displayTemplate | Body-Encoding | Service-Method |
|---|---|---|---|---|
| `notes.create` | write | "Create note: {{title\|body}}" | Free-form Markdown | `createObject` |
| `notes.update` | write | "Update note {{id}}" | Body-replace | `updateObject` |
| `notes.list` | read | — | Body-truncated | `listObjects({subtype:'note'})` |
| `notes.get` | read | — | Full body | `getObject` |
| `notes.delete` | danger | "DELETE note {{id}}" | soft-delete | `deleteObject` |

### §2.6 groups.* — 10 Tools (Phase-2 Sharing)

| Tool | Sensitivity | displayTemplate | Special |
|---|---|---|---|
| `groups.create` | write | "Create group: {{name}}" | Schema 0019/0020, group-DEK init |
| `groups.list` | read | — | Owner+member-of |
| `groups.get` | read | — | Group-Meta + member-count |
| `groups.list_members` | read | — | Member-Liste |
| `groups.add_member` | write | "Add {{email}} to group {{group_id}} as {{role}}" | Group-DEK wrap für neuen Member |
| `groups.remove_member` | danger | "Remove {{member_id}} from group {{group_id}}" | Member-DEK unwrap revoken |
| `groups.invite_email` | write | "Invite {{email}} to group {{group_id}}" | Email-Outbox-Entry, Resend-Adapter |
| `groups.archive` | danger | "ARCHIVE group {{group_id}}" | soft-archive |
| `groups.set_read_audit` | write | "Toggle read-audit for group {{group_id}}" | Setting-Toggle |
| `groups.transfer_ownership` | danger | "TRANSFER ownership of {{group_id}} to {{new_owner}}" | Bidirectional invite |

**Crypto-Layer**: Group-DEK-Wrapping ist KC2-side schon implementiert (KMS-Helpers, group-crypto). Tool-Layer-Migration ist nur Tool-Schema + Service-Call.

### §2.7 sharing helpers — 2 Tools

| Tool | Sensitivity | displayTemplate | Special |
|---|---|---|---|
| `docs.share_with_group` | write | "Share doc {{doc_id}} with group {{group_id}}" | `shares.create` + Group-DEK |
| `skills.share_with_group` | write | "Share skill {{skill_id}} with group {{group_id}}" | dito |

### §2.8 objects.list / objects.read — Browser-Wrapper (Name-Konflikt!)

**Problem**: KC2's primitive heißt schon `objects.list` / `objects.get`. Der approval2-Browser-Wrapper macht body-truncation für PWA-Display.

**Lösung per User-Decision**: KC2's Low-Level-Tools (`objects.create`, `objects.get`, `objects.list`, `objects.update`, `objects.delete`, `objects.restore`, `objects.add_ref`, `objects.remove_ref`, `objects.usages`, `uploads.*`) bekommen `annotations.tags: ['low-level']`. approval2-Auto-Forwarder filtert standardmäßig diese Tools aus (`expose-rule: !tags.includes('low-level')`).

**Konsequenz**: `objects.list/read` als High-Level-Browser-Tools (Body-Truncation) bleiben sichtbar. KC2's `objects.list/get` als Primitive sind via Forwarder-Filter nicht in approval2's tools/list (aber via `objects.list` und High-Level-Wrappers erreichbar).

| Tool | Sensitivity | displayTemplate | Special |
|---|---|---|---|
| `objects.list` (High-Level) | read | — | Browser-friendly Body-Truncation, alle subtypes | reuses `listObjects` |
| `objects.read` (High-Level) | read | — | Browser-friendly, full body | `getObject` |

### §2.9 shares.* — 3 helper Tools

| Tool | Sensitivity | displayTemplate | Special |
|---|---|---|---|
| `shares.revoke` | danger | "REVOKE share {{share_id}}" | refcount-aware |
| `shares.list_my_shares` | read | — | Owner-perspective |
| `shares.list_for_group` | read | — | Group-perspective (bidirectional) |

## §3 Tool-Implementation-Konvention für KC2

### §3.1 File-Layout

```
src/mcp/tools/
├── docs/
│   ├── put.ts
│   ├── get.ts
│   ├── list.ts
│   ├── ...
│   └── index.ts          // export registerDocsTools(register: (t: ToolDef) => void)
├── skills/
├── memorize/
├── lists/
├── notes/
├── groups/
├── shares/
├── objects/              // High-Level Wrapper (Browser-View)
└── index.ts              // export registerAllSubtypeTools()
```

`src/mcp/register_tools.ts` ruft `registerAllSubtypeTools()` auf, ergänzend zu den bestehenden Low-Level-Tools (die jetzt `tags: ['low-level']` bekommen).

### §3.2 Tool-Annotation-Schema (MCP-Standard + KC2-Extension)

```ts
type ToolAnnotations = {
  // MCP-Standard
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;

  // KC2/approval2-Extension (vendor-specific)
  sensitivity: 'read' | 'write' | 'danger';
  displayTemplate: string;  // Mustache-template für PWA-Approval-UI
  tags?: string[];          // z.B. ['low-level'] für Filter
};
```

### §3.3 Wire-Format (Auto-Forwarder-Output)

approval2's `buildKcWrappers()` ([apps/server/src/tools/kc_wrappers/index.ts](https://github.com/axel-rogg/mcp-approval2/blob/main/apps/server/src/tools/kc_wrappers/index.ts)) erwartet bereits dieses Schema. **Keine approval2-Side-Änderung am Forwarder nötig** — solange KC2 die Annotations korrekt liefert, mappt der Forwarder sie auf approval2's `ToolMetadata.annotations`.

## §4 Implementations-Phasen

### §4.1 Phase 1 — Tool-Skeleton in KC2 (Woche 1, ≈ 40h Code)

1. `src/mcp/tools/<family>/` Verzeichnisse anlegen
2. Per Tool-Family: Zod-Schemas in `<family>/schema.ts` definieren (1:1 von approval2 portiert)
3. Per Tool: Implementation als dünner Wrapper über `ObjectsService` / `SharesService` / `EmailOutboxService`
4. Per Tool: Annotations setzen
5. KC2's `register_tools.ts` erweitern
6. Unit-Tests pro Tool (input-validation, output-format)
7. KC2's Low-Level-Tools `annotations.tags: ['low-level']` ergänzen
8. **Acceptance**: KC2 build green, alle neuen Tools über `tools/list` sichtbar, lokaler Smoke

### §4.2 Phase 2 — Contract-Tests + Annotation-Verify (Woche 2, ≈ 20h)

1. `packages/adapters/tests/contract/` in approval2: pro neuem KC2-Tool ein Roundtrip-Test
2. Display-Template-Verify: approval2's [knowledge-tools.test.ts] und [docs-tools.test.ts] etc. testen gegen die KC2-Live-Tools (statt gegen die hardcoded Wrappers)
3. **Acceptance**: alle Contract-Tests grün in approval2-CI gegen ein test-KC2-Image

### §4.3 Phase 3 — approval2-Switch (Woche 3, ≈ 8h)

1. approval2 Doppler: `WRAPPER_SOURCE=kc2` setzen
2. approval2 [tools/index.ts] (https://github.com/axel-rogg/mcp-approval2/blob/main/apps/server/src/tools/index.ts): hardcoded `register…` Calls hinter `if (env.WRAPPER_SOURCE !== 'kc2')` packen
3. Auto-Forwarder läuft sowieso (heute schon aktiv) — wenn hardcoded ausgeschaltet, gewinnen die KC2-Tools
4. `[deploy]` mit smoke gegen prod
5. **Acceptance**: `mcp.ai-toolhub.org/mcp` `tools/list` zeigt KC2-stammende Tool-Definitionen (gleicher Tool-Name, aber andere `displayTemplate`-Provenienz)

### §4.4 Phase 4 — Cleanup approval2 (Woche 4, ≈ 12h)

1. Beobachtungs-Window 1 Woche nach Phase 3 → keine Regression?
2. approval2: hardcoded Wrapper-Files (`docs-tools.ts`, `skills-tools.ts`, `memorize-tools.ts`, `lists-tools.ts`, `notes-tools.ts`, `objects-tools.ts`, `groups-tools.ts`) → `apps/server/src/_to_delete/2026-06-XX/`
3. approval2: `KnowledgeService.createObject/listObjects/etc.` werden ausgedünnt (Service-Layer-API bleibt für Native-Tools `capability_search` notwendig, aber Subtype-Logic raus)
4. Test-Suite-Cleanup: 30+ Tool-Test-Files in approval2 nach `_to_delete/`
5. **Acceptance**: approval2-Tests grün ohne die migrierten Tool-Files

### §4.5 Phase 5 — Doku + Hardening (Woche 5, ≈ 8h)

1. KC2 CLAUDE.md: neuer Abschnitt "MCP-Tool-Surface" mit Tool-Inventar
2. approval2 CLAUDE.md: "kc_wrappers Auto-Generator" → "MCP-Surface kommt aus KC2"
3. ADR-0004-Anhang in KC2: "Convenience-Layer dürfen subtype-aware sein, solange Data-Layer generic"
4. `_to_delete/` hart entfernen in beiden Repos
5. Doppler: `WRAPPER_SOURCE` als Feature-Flag entfernen (Code default kc2)

## §5 Risiken

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| Schema-Drift KC2 vs approval2-Tests | Mittel | Hoch | Phase 2 Contract-Tests vor Switch |
| Body-Encoding-Bug docs.put R2-Routing | Niedrig | Mittel | KC2 hat `createObject`-Encoding, dünner Wrapper |
| YAML-Frontmatter-Parser duplizierung | Mittel | Niedrig | Phase 1 duplizieren, später konsolidieren in `packages/core` |
| `objects.list/read` Konflikt | Aufgelöst | — | `tags: ['low-level']` + Forwarder-Filter |
| Approval-Flow-Hook bricht | Niedrig | Hoch | Auto-Forwarder hat Flow heute schon |
| Performance-Regression (extra MCP-Hop) | Niedrig | Mittel | Heute: REST-Hop. Nachher: MCP-Hop. Latency-Delta ≈ +20ms |
| KC2-Deploy-Failure mitten in Phase 3 | Niedrig | Hoch | `WRAPPER_SOURCE=hardcoded` flip rolled back ohne Code-Deploy |
| Test-Migration vergisst Edge-Case | Mittel | Mittel | Beide Test-Suiten parallel in Phase 2-3 |

**Rollback pro Phase**:
- Phase 1: `git revert` in KC2, kein production-Impact (approval2 nutzt noch hardcoded).
- Phase 2: Tests-Only, kein production-Impact.
- Phase 3: `WRAPPER_SOURCE=hardcoded` via Doppler flip, redeploy approval2.
- Phase 4: `_to_delete/`-Files zurück-`git mv`.
- Phase 5: ADR-Anhang revertieren.

## §6 Service-Method-Mapping (KC2-internal)

Welche bestehenden KC2-Services die neuen Tools aufrufen:

| Tool-Family | Service | Bestehende Methoden ausreichend? |
|---|---|---|
| docs.* | `ObjectsService` | ✓ (createObject mit subtype-Argument) |
| skills.* | `ObjectsService` + neuer `SkillsManifestService` (Parser) | ⚠️ Manifest-Parser muss neu nach KC2 |
| memorize.* | `ObjectsService` + `VectorService` (decay-search) | ⚠️ Time-Decay-Logic muss neu (heute approval2) |
| lists.* | `ObjectsService` + neuer `ListBodyMutator` (Markdown-Toggle) | ⚠️ Toggle-Logic muss neu |
| notes.* | `ObjectsService` | ✓ |
| groups.* | `GroupsService` (vorhanden, Phase 2 LIVE) | ✓ |
| shares.* | `SharesService` (vorhanden) | ✓ (mit neuen High-Level-Helpern) |
| objects.list/read (High-Level) | `ObjectsService` + Body-Truncator | ⚠️ Truncator-Helper neu |
| **Neue Helpers in KC2** | | Manifest-Parser, Time-Decay, List-Mutator, Body-Truncator |

**Approx 4 neue Helper-Klassen in KC2** + ihre Tests.

## §7 Cross-Repo Coordination

| Repo | Owner | Phase |
|---|---|---|
| mcp-knowledge2 | Producer | Phase 1, 2 (Tools + Tests) |
| mcp-approval2 | Consumer | Phase 2 (Contract-Tests), 3 (Switch), 4 (Cleanup) |

**Reihenfolge bei Commits (CLAUDE.md-Konvention)**: KC2 zuerst, approval2 danach. Aktuelles Plan-File (dieses + cross-link) ist Doc-only und gilt nicht als Producer-Commit — kann unabhängig gepushed werden.

## §8 Acceptance-Criteria gesamt

Bei Phase-5-Abschluss:
- [ ] approval2 `tools/list` zeigt ~22 native + ~50 KC2-Tools + N Sub-MCP-Gateway-Tools
- [ ] Alle 48 ehemals-hardcoded Tools sind in KC2 implementiert + getestet
- [ ] `WRAPPER_SOURCE=kc2` ist der einzige produktive Modus (Feature-Flag entfernt)
- [ ] Beide CLAUDE.md-Files updated
- [ ] ADR-0004 hat Convenience-Layer-Anhang
- [ ] `_to_delete/`-Verzeichnisse leer / entfernt
- [ ] Smoke-Tests beide Seiten grün
- [ ] Production stabil seit ≥1 Woche

---

**Nächster Schritt**: Phase 1 Code-Start in diesem Repo (KC2).
