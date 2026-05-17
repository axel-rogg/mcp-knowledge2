# PLAN-Review: Group-basiertes Document-Sharing Phase 1 (KC2)

**Reviewer:** Senior-Backend-Engineer (Postgres / RLS / Drizzle / Storage)
**Scope:** Engineering-Sanity-Check VOR dem ersten Schema-Commit
**Datum:** 2026-05-17
**Crypto:** separat reviewt (CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md) — nicht re-analysiert

---

## 1. Executive Summary

Plan ist **konzeptionell solide** und der Crypto-Review ist eingearbeitet, aber vor dem ersten Commit fehlen ~10 build-blocker mit Postgres-/Drizzle-/RLS-/Cross-Repo-Kontext, die der Plan implizit annimmt. Die wichtigsten:

- **Drizzle-Schema-Sync fehlt:** Plan §1 zeigt nur SQL, [src/db/schema.ts](file:///workspaces/mcp-knowledge2/src/db/schema.ts) braucht parallelen Mirror. Repo hat **kein `drizzle-kit generate`**, Migrations sind handgeschrieben (0000_init.sql:2).
- **RLS-Erweiterung auf `objects.owner_or_shared_read` ist nicht im Plan:** [0001_rls.sql:18-28](file:///workspaces/mcp-knowledge2/drizzle/migrations/0001_rls.sql) filtert auf `share_grants.granted_to=current_user`. Ohne Patch der Subquery sieht ein Group-Member nichts.
- **AAD-Refactor ist breaking-change, nicht nur ein neuer RecordType:** [aad.ts:26-34](file:///workspaces/mcp-knowledge2/src/lib/crypto/aad.ts) hat flaches `AadFields` mit Pflicht-`ownerId`. Variante B braucht eine echte Discriminated-Union + Refactor von 5 Call-Sites.
- **KC2 HTTP-Routes nicht spezifiziert:** [src/routes/](file:///workspaces/mcp-knowledge2/src/routes/) braucht neue `groups.ts` + Erweiterung von `shares.ts:11-15` (Zod-Body akzeptiert nur `granted_to: uuid()`).
- **`object_revisions.dek_scheme` fehlt:** Lazy-Migration produziert Mixed-State (alte Rev legacy, neue Rev per_object). Read-Pfad in [revisions.ts:69](file:///workspaces/mcp-knowledge2/src/storage/revisions.ts) wird brüchig.

**Empfehlung:** Plan-Update vor erstem Commit um §1.0 (Drizzle-Sync), §1.3 (RLS-Patch auf objects), §3a (AAD-Union-Refactor), §8a (KC2-Routes), §11a (Container-Test-Pattern). Aufwand 9.5d → realistisch **12-14d**.

---

## 2. Schema/Migration-Findings

**CRITICAL — Drizzle-Schema-Mirror fehlt.** [src/db/schema.ts:38-204](file:///workspaces/mcp-knowledge2/src/db/schema.ts) muss synchron erweitert werden: `objects.dekScheme/ownerWrappedDek/ownerWrapKeyVersion/cascadeOnShare`, `shareGrants.grantedToGroupId/viaCascadeFromObjectId/wrappedObjectDek/groupMasterVersion`, `grantedTo.notNull()` raus, neue `groups`+`groupMembers` Tables + Re-Export in `schema`-Const (Z. 456-474). Sonst kompiliert Storage-Layer + `tests/integration/rls.test.ts` nicht.

**HIGH — RLS-Policy `objects.owner_or_shared_read` muss erweitert.** [0001_rls.sql:18-28](file:///workspaces/mcp-knowledge2/drizzle/migrations/0001_rls.sql) checkt `share_grants.granted_to=current_user`. Mit Group-Sharing muss zusätzlich: `OR sg.granted_to_group_id IN (SELECT group_id FROM group_members WHERE user_id=current_user AND removed_at IS NULL)`. Plan §1.2 zeigt das NICHT — nur die neuen `groups`/`group_members`-Policies. Gleicher Patch für `owner_or_writer_modify` (Z. 36-57).

**HIGH — `share_grants` RESTRICTIVE-Policy aus Mig 0016.** [0016_share_grants_restrictive_insert.sql](file:///workspaces/mcp-knowledge2/drizzle/migrations/0016_share_grants_restrictive_insert.sql) verlangt `granted_by=current_user AND objects.owner=current_user`. Plan §7 macht Cascade-INSERTs unter Owner-Identität — passt für Phase 1. Wenn aber Phase 2 Write-Capable-Members einführt, bricht das. Plan muss explizit auf "Cascade läuft IMMER unter Owner-Identität, Member kann nicht cascaden" hinweisen.

**MEDIUM — `object_vectors` ist owner-only seit Mig 0014.** [0014_vec_owner_only_rls.sql](file:///workspaces/mcp-knowledge2/drizzle/migrations/0014_vec_owner_only_rls.sql) sperrt Group-Members aus den Embeddings aus. By-design (Embedding-Inversion-Defense). Plan §11 muss dokumentieren: **Group-Members kriegen FTS-Treffer auf shared objects, aber keine Vektor-Treffer**. Sonst Drift zur Mig 0014.

**MEDIUM — Diamond-Index NULL-Pitfall.** Plan §1.1 macht `UNIQUE(resource_id, granted_to_group_id, via_cascade_from_object_id) WHERE revoked_at IS NULL`. `via_cascade_from_object_id IS NULL` bei direkten Shares → Postgres UNIQUE-mit-NULL erlaubt mehrere Direct-Group-Shares desselben Resources auf dieselbe Group. Fix: `COALESCE(via_cascade_from_object_id, '00000000-...')` oder zwei Partial-Indexes (NULL vs. NOT NULL getrennt).

**MEDIUM — `object_revisions.dek_scheme`-Spalte fehlt.** [revisions.ts:67-73](file:///workspaces/mcp-knowledge2/src/storage/revisions.ts) baut AAD `object-revisions|<ownerId>|<objectId>`. Nach Lazy-Migration sind alte Revisions legacy-encrypted, neue Revisions per_object. **Pro-Revision-Tracking nötig** — `ALTER TABLE object_revisions ADD COLUMN dek_scheme TEXT NOT NULL DEFAULT 'owner_hkdf'`. Plan §1.1 fehlt das komplett.

**MEDIUM — `groups.owner_id` ohne FK.** Plan §1.1: `owner_id UUID NOT NULL` — keine `REFERENCES users(id)`. Wenn Owner via GDPR-Erase ([objects.ts:611-625](file:///workspaces/mcp-knowledge2/src/storage/objects.ts) `hardDeleteByOwner`) gelöscht wird, bleiben Groups orphaned. Plan §6 fehlt: Erase-Sequence muss Group-Owner-Transfer / Auto-Archive triggern.

**LOW — Migration-Atomicity.** Postgres macht DDL in einer TX (kein `CREATE INDEX CONCURRENTLY` im Plan, gut). Bei Crash rollbacked alles. Plan sollte explizit "ein File, kein CONCURRENTLY" sagen.

---

## 3. Test-Infrastructure-Findings

**HIGH — Testcontainer-Pattern funktioniert, neue RLS-Tests sind Pflicht.** [tests/integration/rls.test.ts:43-50](file:///workspaces/mcp-knowledge2/tests/integration/rls.test.ts) apply'd alle Migrations lexikographisch — neue `0019_*.sql` läuft automatisch mit. **Aber:** keiner der 28 Tests prüft `granted_to_group_id`. Phase-1-PR muss mind. 5 neue Tests dazu: Group-Member-Read, Removed-Member-Block, Cross-Group-Leak-Block, Cascade-INSERT-RESTRICTIVE-Check, Diamond-Cascade-Uniqueness.

**MEDIUM — Storage-Unit-Tests gibt es nicht.** Es existieren KEINE `src/storage/*.test.ts` — Tests liegen in `tests/{unit,integration,contract}/`. Plan §11 muss klären: Cycle-Detection-Race + Lazy-Migration-Atomicity → `tests/integration/groups.test.ts` (gleicher Container-Pattern), Crypto-Domain-Separation → `tests/unit/crypto.test.ts`.

**HIGH — Contract-Tests für Cross-Service-API.** [apps/server/tests/contract/manifest-roundtrip.test.ts](file:///workspaces/mcp-approval2/apps/server/tests/contract/manifest-roundtrip.test.ts) ist Producer-Side-Truth. Phase 1 braucht zusätzlich `groups-roundtrip.test.ts` (KC2 `/v1/groups/*`-Shape) + `shares-with-group.test.ts` (Cascade-Antwort mit `via_cascade_from_object_id`). Plan §11 fehlt das.

**MEDIUM — Pilot-Smoke.** [scripts/pilot-smoke.sh](file:///workspaces/mcp-approval2/scripts/pilot-smoke.sh) hat keine Group-Operationen. Phase 1 braucht E2E-Pfad: create-group → add-member → share-skill-with-group → read-as-member.

---

## 4. Code-Pfade die der Plan unterspezifiziert

**CRITICAL — AAD-Union ist breaking-change, 5 Call-Sites.** [aad.ts:26-34](file:///workspaces/mcp-knowledge2/src/lib/crypto/aad.ts) hat flaches Interface, kein Discriminated-Union. Plan §3 zeigt Union-Erweiterung — alle Call-Sites einzeln umstellen: [objects.ts:168,363,442](file:///workspaces/mcp-knowledge2/src/storage/objects.ts), [revisions.ts:69](file:///workspaces/mcp-knowledge2/src/storage/revisions.ts), [uploads.ts:131](file:///workspaces/mcp-knowledge2/src/storage/uploads.ts), [middleware/idempotency.ts:33](file:///workspaces/mcp-knowledge2/src/middleware/idempotency.ts). **Idempotency + uploads bleiben legacy** (kein per_object-Switch) — Plan muss explizit klären welche RecordTypes wechseln.

**HIGH — `readObject` dispatch-Logic.** [objects.ts:352-359](file:///workspaces/mcp-knowledge2/src/storage/objects.ts) wirft 501. Plan §5 ersetzt das, aber **die Dispatch-Logic muss als ERSTE Bedingung in der Funktion stehen** (vor Z. 361 `kms().resolveUserDek(...)`), nicht erst im non-Owner-Branch. Sonst bricht Owner-Read auf migrierten Objects.

**HIGH — `updateObject` muss MIT umgestellt werden.** [objects.ts:429-465](file:///workspaces/mcp-knowledge2/src/storage/objects.ts) lädt Owner-DEK + legacy-AAD. Für `dek_scheme='per_object'` muss es `unwrap(row.owner_wrapped_dek, ownerKek)` + AAD v2 nutzen. Crypto-Review §3.2 erwähnt das, aber Build-Plan §5 redet nur über `readObject`. **Item 5 muss explizit `updateObject` mitnehmen** — sonst sind migrierte Objects read-only für Owner.

**MEDIUM — Cycle-Detection + Cascade-Lock-Order.** [refs.ts:114-136](file:///workspaces/mcp-knowledge2/src/storage/refs.ts) macht BFS-Depth-32 mit Random-Reads auf `objects`. Plan §7 hängt einen `FOR UPDATE` auf parent-Skill dahinter in derselben TX. Lock-Order-Risiko bei parallelen Diamond-Cascades. Plan muss explizit: Cycle-Detection läuft VOR `FOR UPDATE`, dann lock-acquisition single-point.

**MEDIUM — `hardDeleteByOwner` (GDPR-Erase).** [objects.ts:611-625](file:///workspaces/mcp-knowledge2/src/storage/objects.ts) ist BYPASSRLS, FK-CASCADE auf `share_grants.resource_id` löscht direkte+Cascade-Grants. **Aber:** wenn `users.id` gelöscht wird, bleiben `groups.owner_id` orphan und `group_members.user_id` ebenfalls. Plan §6 fehlt: Erase-Flow muss `groups`-Behandlung dokumentieren.

**LOW — Cron-Jobs.** [src/crons/](file:///workspaces/mcp-knowledge2/src/crons/) hat backup/sweep/idempotency_gc — keiner liest `dek_scheme`. Phase 1: nichts zu tun. Phase 2 für purge-revoked-shares: KMS-aware.

---

## 5. Tool-Surface / PWA-Integration-Findings

**HIGH — Sensitivity-Wahl für `groups.add_member`.** Plan §8 listet `'danger'`. In approval2 triggert `'danger'` zusätzlich PRF-Eval (Re-Auth). Für add_member überdimensioniert. Empfehlung: `'write'` mit display_template das den Impact zeigt ("X kann ab dann alle Gruppen-Inhalte lesen"). Plan muss diese Entscheidung explizit treffen.

**HIGH — KC2 HTTP-Routes.** [src/routes/](file:///workspaces/mcp-knowledge2/src/routes/) hat objects/shares/search/uploads/internal. **Kein File `groups.ts`.** Plan §8 listet Tools, nicht Routes. Phase 1 braucht:
- `src/routes/groups.ts` — POST/GET `/v1/groups`, GET/DELETE `/v1/groups/:id`, POST/DELETE `/v1/groups/:id/members/:user_id`
- `src/routes/shares.ts` Erweiterung — [shares.ts:11-15](file:///workspaces/mcp-knowledge2/src/routes/shares.ts) `granted_to: z.string().uuid()` → Union mit `granted_to_group_id`.

**HIGH — HttpKnowledgeAdapter.** [packages/adapters/src/knowledge/http-client.ts:554-590](file:///workspaces/mcp-approval2/packages/adapters/src/knowledge/http-client.ts) hat createShare/listShares/revokeShare. Plan §8 listet 12 Tools — Adapter braucht ~6 neue Methoden (`createGroup`, `listGroups`, `addMember`, `removeMember`, `setReadAudit`, `shareWithGroup`). Adapter-Unit-Tests + Mock-fetch-Pattern existiert in [http-client.test.ts:795-800](file:///workspaces/mcp-approval2/packages/adapters/src/knowledge/http-client.test.ts) — analog erweitern.

**MEDIUM — PWA-Routes.** [apps/web/src/main.ts:7-90](file:///workspaces/mcp-approval2/apps/web/src/main.ts) hat `#/storage`, `#/admin`, `#/apps`, `#/tools/*`. Plan §9 macht `#/groups`. **Empfehlung: `#/admin/groups`** — Group-Management ist Administrations-Operation, passt zum bestehenden `#/admin`-Tab.

**LOW — "Shared with me" als Filter, nicht eigene Sektion.** Storage-Tab hat schon `subtype`-Filter. Weiterer Toggle `owned|shared-with-me|both` ist UI-konsistenter.

**LOW — Cascade-Count-Preview.** `skills.share_with_group.execute` muss vor Approval-Build die Cascade-Count berechnen (Plan §9 fordert "Schließt ein: 12 verknüpfte Dokumente") und in displayTemplate-Substitution einsetzen. Aufwand +0.5d.

---

## 6. Roll-back-Safety + Migration-Reihenfolge

**Roll-back-Behauptung "additiv" stimmt teilweise.**
- DROP TABLE `groups`, `group_members` → trivial
- DROP COLUMN auf `objects`, `share_grants` → trivial
- **NICHT trivial:** `ALTER COLUMN granted_to DROP NOT NULL` Roll-back failt wenn pre-Roll-back ein group-share inserted wurde (granted_to=NULL). Recovery: `DELETE WHERE granted_to IS NULL` oder Backfill.
- **NICHT trivial:** RLS-Patch auf `objects.owner_or_shared_read` — Roll-back-Reihenfolge muss erst Code revert (501-throw wieder aktiv), DANN Policy revert. Sonst sieht Old-Code Multi-Member-Shares.

**Plan §12 muss eine echte Roll-back-Sequenz dokumentieren:**
1. Code-Deploy (Read-Pfad für Group-Shares aktiv)
2. Migration apply
3. Bei Roll-back: erst Code revert, dann (optional) Migration revert

**Constraint-Validate-Ordering:** Plan §1.1 chained ALTER TABLE share_grants korrekt — `groups` wird vor `REFERENCES groups(id)` create'd. Sequential apply in einem File ist sicher. Wenn jemand das aufteilt: warnen.

**Partial-Apply:** Postgres DDL in TX → atomic. Crash rollbacked alles. Sicher.

---

## 7. Was im Plan unklar/missing ist

| # | Punkt | Vorschlag |
|---|---|---|
| 1 | Drizzle-Schema-Sync | Plan §1.0 hinzufügen |
| 2 | RLS-Policy `objects.owner_or_shared_read` erweitern | Plan §1.2 ergänzen |
| 3 | `object_revisions.dek_scheme` Spalte | Plan §1.1 ergänzen |
| 4 | AAD-Union als breaking-change, 5 Call-Sites | Plan §3 als breaking kennzeichnen |
| 5 | KC2 HTTP-Routes `groups.ts` | Plan §8a — Route-Skeleton |
| 6 | HttpKnowledgeAdapter-Methoden | Plan §8b — Adapter-Erweiterung |
| 7 | Service-Deploy-Reihenfolge | Plan §12a — KC2 zuerst, dann approval2 |
| 8 | Pilot-Smoke E2E-Test | Plan §11a — Group-Roundtrip |
| 9 | GDPR-Erase + Group-Owner | Plan §6 — was bei Owner-Erase? |
| 10 | Diamond-Index NULL-Pitfall | Plan §1.1 — Partial-Index-Split |
| 11 | `sensitivity='danger'` vs `'write'` für add_member | Plan §8 — Entscheidung begründen |
| 12 | Search-Behavior für Group-Members (kein Vec) | Plan §11 — Test + Doku |
| 13 | Cascade-Count-Preview im displayTemplate | Plan §9 — Compute-Pfad |
| 14 | `updateObject` muss in Item 5 mit-umgestellt | Plan §5 — explizit aufnehmen |
| 15 | Cascade-Lock vs. Cycle-Detection-Order | Plan §7 — Sequence dokumentieren |

---

## 8. Aufwand-Sanity-Check + Empfehlung

**Plan:** ~9.5 Tage. **Realistisch: 12-14 Tage** (~30% Overhead).

| Item | Plan | Real | Differenz |
|---|---|---|---|
| 1 Migration | 1d | 1.5d | + Drizzle-Sync, + RLS-objects-Patch, + revisions.dek_scheme |
| 2 KMS | 1d | 1d | passt |
| 3 AAD-v2 | 0.5d | 1d | Union-Refactor + 5 Call-Sites |
| 4 Lazy-Migration | 1d | 1.5d | + revisions-Pfad, + R2-Case-Tests |
| 5 Read-Pfad | 1d | 1.5d | + updateObject mit-umstellen |
| 6 Group-CRUD | 1.5d | 2d | + KC2-Routes, + Adapter, + RLS-Restrictive-Test |
| 7 Cascade | 0.5d | 1d | + Diamond-Index, + Cycle-Lock |
| 8 Tool-Surface | 0.5d | 1d | 12 Tools × Zod × displayTemplate × Adapter |
| 9 PWA | 1.5d | 2d | + `#/admin/groups`, + Cascade-Count-Preview |
| 10 Tests + Audit | 1d | 1.5d | + Pilot-Smoke, + Contract-Tests |

**Hidden Complexity Top-3:**
1. **Lazy-Migration + object_revisions-dek_scheme** — pro-Revision-Tracking subtil, 3 Test-Szenarien
2. **RLS-Subquery objects → share_grants → group_members** — Performance-Hotspot bei großen Beständen
3. **AAD-Union in Idempotency-Middleware** — falscher Branch öffnet Replay-Window

**Was ZUERST bauen: Item 1 + Item 3 parallel.**
- Schema-Migration + AAD-v2-Refactor zusammen, weil beide breaking-changes mit kleinem Code-Pfad sind
- Größte De-Risking-Wirkung: nach Tag 2-3 hat man lauffähige Schema-Surface + neue AAD-Slots
- Items 4-7 können danach in 2 Parallel-Tracks laufen (Lazy-Migration solo, Read+Group-CRUD pair)
- Item 6 (Group-CRUD) **nicht starten** vor Item 3 fertig — sonst doppelter Refactor auf Insert-Pfaden

**Final-Build-Reihenfolge:** 1+3 → 4 → 5+6 → 7 → 2 → 8 → 9 → 10.

---

## 9. Conclusion

Plan ist **fast** build-fähig. Crypto-Korrekturen eingearbeitet, Schema-Layout stimmt, Atomicity-Argument sauber. **Aber:** 15 unter-spezifizierte Punkte (Drizzle-Sync, RLS-Patch auf objects, AAD-Union, KC2-Routes, revisions-dek_scheme) müssen vor dem ersten Commit ergänzt werden — sonst Compile-Fail oder Test-Brüche ohne klaren Trace. Aufwand 9.5d ist zu optimistisch, 12-14d realistisch.

**Build-Reihenfolge:** Migration + AAD-v2 zusammen als Pair-Start. Item 6 (Group-CRUD) erst nach Item 3 (AAD-Union). Plan-Update auf ~15 Punkte ist 0.5d Doku-Arbeit — lohnt sich gegenüber 2-3d Code-Refactor mid-build.

**Empfehlung:** Plan-Update annehmen, dann Item 1 + 3 starten. Crypto-Review-Brief bleibt valide.
