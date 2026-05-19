# Test-Strategie — mcp-knowledge2

> **Status:** Konzept 2026-05-19. Komplementär zu
> [PRE-GOLIVE-TESTPLAN.md](PRE-GOLIVE-TESTPLAN.md) (Akzeptanz-Matrix WAS) —
> dieses Dokument klärt das **WIE**.
> **Scope:** Test-Varianten, ihre Stärken/Grenzen, Coverage-Map, Lessons
> aus dem Wrapper-Migration-Sprint (welche Tests hätten welchen Drift früher
> gefangen).

---

## §1 Grund-Frage: was muss ein Test eigentlich beweisen?

Bei einem Datenservice wie KC2 zerfallen die Risiko-Klassen klar:

1. **Daten-Verlust / Daten-Korruption** — Bug in Encryption, RLS, Migration,
   Backup. Worst-case rückwärts nicht reparierbar.
2. **Daten-Leak** — falsche RLS, falscher Audit, fehlende Auth-Gate. Worst-
   case Compliance-Vorfall.
3. **Behavioral-Drift** — Tool tut nicht was sein Schema verspricht. Bei
   uns akut nach dem Wrapper-Migration-Sprint 2026-05-18/19.
4. **Wire-Format-Drift** — Schema in KC2 ≠ Schema das approval2 erwartet.
   Stiller Caller-Brake.
5. **Performance-Regression** — N+1, Index-Drop, Lock-Contention. Sichtbar
   erst unter Last.
6. **Operations-Fehler** — Boot fail-closed, Crons rennen leer, Restore
   failt im Notfall. Sichtbar erst im Notfall.

Jede Test-Variante adressiert eine andere Risiko-Klasse — keine deckt alle
ab. Die Pyramide ist eine **Lastenteilung**, nicht eine Hierarchie.

---

## §2 Die Test-Pyramide für KC2

```
                  Drill (Operator)
              ─────────────────────────
                  Manual / Pair-Session
              ─────────────────────────
                  E2E (echte MCP-Clients)
                  Smoke (HTTP gegen live)
              ─────────────────────────
                  Integration (testcontainers)
              ─────────────────────────
                  Contract (Wire-Format)
              ─────────────────────────
                  Sanity (Schema-Shape)
                  Unit (Pure-Logic)
```

Von unten nach oben: schneller + günstiger + breitere Coverage, aber näher
am Code-Internal als am User-Wahrnehmung. Von oben nach unten: langsamer +
teurer, aber näher an dem was tatsächlich kaputt geht beim echten User.

Beim Wrapper-Migration-Sprint haben wir folgenden Fehlschluss gemacht:
**"Schema-Sanity grün + Storage-Integration grün = Cleanup-Ready"**. Das
hat geringere Test-Schichten als äquivalent behandelt zu höheren. Ist sie
nicht. Ein neuer Tool-Wrapper kann ein perfektes Schema haben und beim
Handler-Aufruf trotzdem den falschen storage-Layer-Call machen.

### §2.1 Unit-Tests (pure-logic, kein I/O)

**Was:** Reine Funktionen ohne Side-Effects. Crypto-Primitiven, JSON-Schema-
Konverter, Rate-Limiter, Retry-Backoff, RRF-Score-Berechnung.

**Inventar:** `tests/unit/{crypto,group-crypto,rrf,retry,rate_limit,pii}.test.ts`

**Stärke:** mikrosekundenschnell, isoliert, einfach zu schreiben, fängt
Math/Logik-Bugs zuverlässig.

**Grenze:** Sagt nichts über das Verhalten in einer echten Pipeline. Kann
einen Bug haben "Funktion akzeptiert nur strings, Real-Caller schickt
Buffer" und der Unit-Test wäre trotzdem grün.

**Wann nutzen:** Algorithmische Kern-Stücke (AAD-Konstruktion, Decay-
Score, RRF-Fusion). Bei Wrapper-Migration: für Helper wie
`listMutator.toggleCheckbox` oder `summary.composeEmbedSource`.

### §2.2 Sanity-Tests (Schema-Shape ohne DB)

**Was:** Tests gegen die statische Registry — `registerAllTools()` wird
in `beforeAll` einmal aufgerufen, dann werden die emitierten Tool-Manifest-
Einträge inspiziert. Kein DB, kein Container, keine Handler-Ausführung.

**Inventar:** `tests/sanity/{tools-sanity,wrapper-migration-fixes}.test.ts`

**Stärke:** sub-Sekunde, fängt Schema-Shape-Drift (Tool registriert? Name
korrekt? Sensitivity gesetzt? required[] enthält die Pflicht-Felder?
displayTemplate vorhanden bei Write-Tools?). Auch der Drift-Wächter für
"Tool-Inventory wird kleiner/grösser ohne Doku-Update".

**Grenze:** Sagt **nichts** darüber, ob der `handler` korrekt arbeitet.
Wenn `notes.create` registriert ist mit Schema `{title, body}` und der
Handler intern `createObject({subtype:'note', tile, body})` (tippfehler
tile statt title) ruft, ist der Sanity-Test grün.

**Wann nutzen:** Drift-Detektion auf der Tool-Manifest-Surface. Erste
Verteidigungslinie nach jeder Wrapper-Änderung. Schnell genug für jeden
CI-Run.

**Lesson Wrapper-Sprint:** Sanity-Tests haben den Code-Pattern-Drift
korrekt gemeldet (Tags vorhanden, sensitivity 'danger' statt
'destructive'). Sie haben aber NICHT erkannt, dass `objects.browse_read`
mit nicht-UUID-IDs in Production crashen würde — weil das ein
Handler-Runtime-Bug ist, kein Schema-Drift.

### §2.3 Contract-Tests (Wire-Format)

**Was:** Tests gegen die Wire-Spezifikation zwischen KC2 ↔ approval2 (und
KC2 ↔ MCP-Client). Sie verifizieren dass die emitierten Strukturen das
matchen was die Gegenseite erwartet.

**Inventar:** `tests/contract/{mcp-tools-list,obo-jwt,oauth-self-token,user-sync}.test.ts`

**Stärke:** Fängt Wire-Format-Drift zwischen Producern und Consumern.
Schnell (keine DB), aber näher an der Realität als Sanity.

**Grenze:** Nur so weit wie der erwartete Contract dokumentiert ist. Wenn
approval2 still einen neuen Output-Feldnamen erwartet (`hits` statt
`items`) und das Contract-Test-File das nicht weiss, fängt der Test es
nicht. **Plus: Contract-Tests sind Producer-Side** — sie verifizieren was
KC2 emittiert. Sie können nicht testen ob approval2's Consumer-Code
tatsächlich damit klarkommt.

**Wann nutzen:** Bei jeder Schema-/Annotation-Änderung in der MCP-Surface.
Bei OBO-Token-Format-Änderungen. Cross-Service-Audit-Events.

**Lesson Wrapper-Sprint:** Contract-Tests haben den `'destructive'` →
`'danger'` Drift nicht gefangen, weil der Test die KC2-konformen Werte
allowliste, nicht das approval2-Mapping. Erst der menschliche Code-
Review/Subagent-Analyse hat es entdeckt. Ergänzung nötig: bidirektionale
Contract-Tests die **auch die Consumer-Annahmen** testen.

### §2.4 Integration-Tests (testcontainers, DB live)

**Was:** Tests die `@testcontainers/postgresql` mit pgvector starten,
Migrations durchziehen, dann gegen einen echten REST-Endpoint oder eine
echte Storage-Funktion gehen. Crypto + RLS + Transactions echt.

**Inventar:** `tests/integration/{rls,groups,objects-roundtrip}.test.ts`

**Stärke:** Fängt RLS-Bypass, Transaction-Race, Migration-Drift, Crypto-
Roundtrip-Bugs. Beste Coverage-Quelle für Daten-Korruption-Risiken.

**Grenze:** Braucht Docker (nicht im Codespace; läuft in CI auf GH-Actions-
Runner). 5-20s pro Test wegen Container-Boot. **Wichtig: existing Tests
treffen REST-API + storage-layer, NICHT die MCP-Tool-Wrappers in
`src/mcp/tools/*.ts`.** Das ist die größte aktuelle Coverage-Lücke.

**Wann nutzen:**
- Daten-Schicht-Änderungen (Migrations, RLS-Policies, Crypto-Wraps)
- Storage-Funktions-Änderungen (`createObject`, `addRef`, etc.)
- Anytime ein Handler einen multi-step DB-Roundtrip macht (CAS, refcount-
  aware delete, lazy-migration)

**Lesson Wrapper-Sprint:** Die 7 must-fix-Items, die der Diff-Subagent
fand, wären **alle** durch Integration-Tests der MCP-Tools direkt
abgefangen worden:
- #1 UUID-Constraint: `runRegisteredTool('objects.browse_read', {id:
  'ulid_xx'})` → würde Zod-Throw zeigen
- #3 skills lazy-migration: existierender Skill mit `meta.resource_ids` →
  `skills.put` aufrufen → `listOutgoingRefs` prüfen
- #5 docs.usages enrichment: docs mit ref → `docs.usages` → check
  `incoming[0].title` undefined
- usw.
Die existing tests konnten das nicht, weil sie REST nicht MCP testeten.

### §2.5 Smoke-Tests (HTTP gegen live Instance)

**Was:** Bash- oder Node-Skripte die HTTP-Requests an einen laufenden
Server schicken und Statuscodes/Response-Shapes prüfen.

**Inventar:** `scripts/smoke.sh` (Layer-3, manual + cron 06:00 UTC).
Workflow: `.github/workflows/smoke.yml`. Probes: `/health`, `/version`,
`/metrics`, `/v1/objects` mit JWT.

**Stärke:** Schnell, läuft gegen production. Fängt regression im Wire-
Format oder im Deploy-Layer (Env-Vars fehlen, Migrations nicht
ausgeführt). Drift-Wall die regelmässig läuft.

**Grenze:** Nur Surface-Probes. Keine echte Datenkonsistenz-Verifikation.
Kann nicht Multi-Step-Flow (Approval-Roundtrip mit OBO) testen.

**Wann nutzen:** Daily-Check der Health-Surface. Post-Deploy-Verifikation.
Layer-3 in der Test-Pyramide.

**Lesson Wrapper-Sprint:** smoke.sh testet `/v1/objects`, nicht `/mcp`.
Hat darum den OBO-JWT-Verification-Bug (Phase-3-Block) nicht gefangen.
Ergänzung nötig: smoke-Pfad gegen `/mcp` mit Service-Token+JWT.

### §2.6 E2E (echte MCP-Clients)

**Was:** Pair-Session mit Browser + claude.ai + MCP-Inspector. Manuell.

**Inventar:** keiner als Automated. Nur als Manual-Items in
[PRE-GOLIVE §7g](PRE-GOLIVE-TESTPLAN.md).

**Stärke:** Einzige Test-Variante die das WYSIWYS-Prinzip am echten User
verifiziert. Fängt UX-Drift (Approval-Display sagt was anderes als der
tatsächliche Call).

**Grenze:** Nicht-automatisierbar, nicht reproducible, fehleranfällig.
Nicht für CI.

**Wann nutzen:** Pre-Go-Live, nach jeder grösseren Surface-Änderung,
nach Approval-Flow-Änderungen in approval2.

**Lesson Wrapper-Sprint:** E2E wurde post-Phase-3 NICHT durchgeführt
(kein dedicated Pair-Session). Sollte vor Phase-4-Soft-Delete passieren.

### §2.7 Drill (Operator-Übung)

**Was:** Restore, Token-Rotation, Rollback-Drill. Einmal pro Jahr (oder
nach grösserer Architektur-Änderung) durchgespielt.

**Inventar:** `scripts/restore-backup.ts`, Runbooks in `docs/runbooks/`.

**Stärke:** Einzige Test-Variante die operative Skills frischhält. Fängt
Run-Book-Drift.

**Grenze:** Aufwendig, einmalig, kein CI-Gate.

**Wann nutzen:** Quartal-/Jahres-Rhythmus + nach jeder Schema-Migration
die das Backup-Format anfasst.

### §2.8 Manual / Pair-Session

**Was:** Ein Mensch klickt durch ein Szenario, oft mit zwei Personen für
Sharing-Tests.

**Inventar:** [PRE-GOLIVE §3.9, §4.*, §6.*, §7g.*](PRE-GOLIVE-TESTPLAN.md)

**Stärke:** Einzige Test-Variante die UX und Approval-Display real
prüft.

**Grenze:** nicht-reproduzierbar, time-consuming.

**Wann nutzen:** Vor Go-Live, Pair-Sessions explizit für Sharing.

---

## §3 Coverage-Matrix: Risiko-Klasse × Test-Variante

| Risiko-Klasse | Unit | Sanity | Contract | Integration | Smoke | E2E | Drill | Manual |
|---|---|---|---|---|---|---|---|---|
| **Daten-Verlust** (Encrypt/Backup) | ◆◆ | – | – | ◆◆◆ | ◆ | – | ◆◆◆ | – |
| **Daten-Leak** (RLS/Auth) | ◆ | – | ◆ | ◆◆◆ | ◆ | – | – | ◆ |
| **Behavioral-Drift** (Handler-Bug) | ◆ | ◆ | ◆ | ◆◆◆ | ◆◆ | ◆◆ | – | ◆ |
| **Wire-Format-Drift** (Caller-Brake) | – | ◆◆ | ◆◆◆ | ◆ | ◆ | ◆◆ | – | ◆ |
| **Performance-Regression** | – | – | – | ◆ | ◆◆ | ◆ | – | ◆ |
| **Operations-Fehler** (Boot/Restore) | – | – | – | – | ◆◆ | – | ◆◆◆ | ◆ |

Legende: ◆ schwach, ◆◆ solide, ◆◆◆ primäre Verteidigungslinie, – nicht
adressiert.

**Aktuelle Coverage-Lücken** (aus dem Wrapper-Sprint identifiziert):

1. **MCP-Tool-Wrapper-Runtime-Tests fehlen komplett.** Existing
   Integration-Tests treffen REST + storage, nicht `runRegisteredTool`.
   → Behavioral-Drift bei den 47 neuen Wrappers ist nur durch Sanity
   abgedeckt (Schema-Shape), nicht durch Handler-Verifikation.

2. **Cross-Service-Contract-Tests sind one-sided.** KC2-Side prüft KC2's
   Emit-Schema. approval2-Side prüft approval2's Consumer. Niemand prüft
   "kann approval2-Forwarder tatsächlich KC2's tools/list parsen ohne
   crash". → Wire-Format-Drift wie `'destructive'` vs `'danger'` rutscht
   durch.

3. **Smoke-Test gegen `/mcp` fehlt.** smoke.sh testet `/v1/*` REST. OBO-
   JWT-Bug aus Phase-3 wäre gefangen worden wenn smoke einen
   `/mcp tools/list`-Call gegen prod machte.

4. **Tool-Inventory-Drift-Wächter fehlt.** Wenn ein Subagent versehentlich
   ein Tool nicht registriert, fängt das niemand bis ein Manual-Test es
   bemerkt. Ergänzung: ein Count-Test pro Family.

5. **JSON-Schema-Konverter-Tests fehlen.** `src/mcp/json-schema.ts` ist
   eigenes Stück Code. Bei neuen Zod-Konstrukten in Tool-Inputs ist das
   eine stille Drift-Quelle. Wir haben das bei `.refine()` selbst
   entdeckt — niemand prüft proaktiv ob `ZodDiscriminatedUnion` oder
   `ZodTuple` schlummern.

---

## §4 Empfohlene Test-Schichten für die offenen Risiken

### §4.1 Neue Schicht: **MCP-Tool-Runtime-Tests**

Ort: `tests/integration/mcp-tools-runtime.test.ts` (oder pro Family aufgeteilt).

Pattern:
```
beforeAll: testcontainer-Postgres + registerAllTools()
beforeEach: USER_A = uuid; ctx via withContext({userId:USER_A, requestId})
test 'notes.create stores subtype="note"':
  result = await runRegisteredTool('notes.create', {title, body})
  expect((await getObject(result.id)).subtype).toBe('note')
test 'objects.browse_read accepts ULID':
  await runRegisteredTool('objects.browse_read', {id: ULID_TEST})
  // expect kein Schema-Throw, expect richtige body-truncation
```

**Coverage:**
- Alle 47 high-level Wrappers mit happy-path + 1 negative case (Schema-
  Validation-Fail).
- Alle Wrapper die spezielle Handler-Logik haben (`docs.delete force=true`,
  `skills.put lazy-migration`, `lists.tick line-index vs match`).
- Output-Shape-Verifikation (cursor dual-emit, hits+items, title+subtype
  enrichment).

**Aufwand:** ~2 Tage. Reuse vom testcontainer-Setup aus
`objects-roundtrip.test.ts`.

**Wert:** Beseitigt die 70%-Vertrauens-Lücke die wir gerade haben. Fängt
zukünftige Wrapper-Migration-Drift.

### §4.2 Bidirektionale Contract-Tests

Ort: bestehender `tests/contract/mcp-tools-list.test.ts` erweitern. Plus:
einen Cross-Repo-Test in approval2 der KC2's Live-tools/list parsed +
durch den Forwarder schiebt, ohne Throw.

**Coverage:**
- Wire-Format-Drift wie `'destructive'`/`'danger'` (approval2's
  resolveSensitivity wird gegen jedes KC2-Tool ausgeführt).
- Cursor-Field-Drift (`next_cursor`/`nextCursor` parallel).
- displayTemplate-Mustache-Render mit sample args.

**Aufwand:** ~1 Tag. Braucht eine kleine cross-repo-Test-Infrastructure
(KC2 muss ein test-tools-list als JSON-Fixture exportieren, approval2-side
parsed das).

### §4.3 MCP-Smoke gegen `/mcp`

Ort: `scripts/smoke.sh` erweitern oder `scripts/smoke-mcp.sh` neu.

Pattern:
```
1. POST /mcp {method: 'initialize'} → status 200, protocolVersion gesetzt
2. POST /mcp {method: 'tools/list'} mit SERVICE_TOKEN → 47+16 Tools
3. POST /mcp {method: 'tools/call', params:{name: 'objects.browse_list'}}
   mit SERVICE_TOKEN → 403 (Service-Mode-Filter greift)
4. POST /mcp {method: 'tools/call', ...} mit OBO-JWT → 200
```

**Coverage:** Boot-Smoke der MCP-Surface. Daily.

**Aufwand:** ~2h. Existing smoke.sh-Patterns reusen.

### §4.4 Tool-Inventory-Drift-Wächter

Ort: `tests/sanity/tools-sanity.test.ts` erweitern (existiert schon mit
Counts pro Family in `byFamily`).

Plus: pro Family eine kanonische Liste der erwarteten Tool-Names. Wenn
ein Tool aus der Liste fehlt oder ein neues dazukommt, fail-loud.

**Coverage:** Tool-Surface-Drift. Schneller als Code-Review.

**Aufwand:** ~30min.

### §4.5 JSON-Schema-Konverter-Tests

Ort: `tests/unit/json-schema.test.ts` (fehlt heute komplett).

Pattern:
```
test 'ZodOptional unwraps to inner type'
test 'ZodEffects (.refine) unwraps to inner'
test 'ZodNullable produces [type, "null"]'
test 'ZodArray produces {type:"array", items}'
test 'ZodObject produces {type:"object", properties, required}'
test 'Unknown Zod-Type throws (no silent {})'
```

**Coverage:** Drift-Quelle wenn neue Zod-Konstrukte in Tool-Inputs
auftauchen. PRE-GOLIVE §7h.

**Aufwand:** ~2h. Pure-unit-test, kein I/O.

---

## §5 Was der Wrapper-Migration-Sprint uns gelehrt hat

7 must-fix-Items wurden nach der Migration durch manuelle Code-Inspektion
gefunden (Subagent-Diff). Hätte ich die Schichten parallel gehabt, hätten
wir Folgendes gesehen:

| Drift-Item | Welche Schicht hätte's gefangen? | Heute abgedeckt? |
|---|---|---|
| #1 UUID-Constraint zu schmal | Integration-Test mit ULID-Input | Nein |
| #2 Tool-Rename objects.list→browse_list | Bidirectional Contract / PWA-Audit | PWA-Audit gemacht (Subagent B) |
| #3 skills.put legacy resource_ids | Integration-Test mit pre-existing skill | Nein |
| #4 Cursor field-name (snake vs camel) | Bidirectional Contract | Nein |
| #5 docs.usages title fehlt | Integration mit refcount > 0 | Nein |
| #6 memorize.search hits vs items | Bidirectional Contract / Integration | Nein |
| #7 'destructive' vs 'danger' | Bidirectional Contract (resolveSensitivity-Run) | Nein |

**Schlussfolgerung:** 5 von 7 Items wären durch **eine Schicht "MCP-Tool-
Runtime-Tests"** (Integration mit `runRegisteredTool`-Direct-Calls)
gefangen worden. 2 von 7 brauchen bidirektionale Contract-Tests.

Diese beiden Schichten sind **die wichtigste Priorität** für die nächste
Test-Sprint-Welle.

---

## §6 Prioritäten — was als nächstes konkret schreiben

Basierend auf PRE-GOLIVE Pending-Liste + Wrapper-Sprint-Lessons:

**Sprint 1 (Daten-Integrität, Wire-Format):**
1. `tests/integration/mcp-tools-runtime.test.ts` — die fehlende Schicht
   (§4.1). 47 Wrappers, ~2 Tage.
2. `tests/unit/json-schema.test.ts` — Zod-Konverter (§4.5). ~2h.
3. `tests/contract/mcp-transport.test.ts` + `mcp-lifecycle.test.ts` +
   `mcp-service-mode.test.ts` — PRE-GOLIVE §7a/b/c. ~1 Tag.
4. `scripts/smoke-mcp.sh` — MCP-Smoke gegen prod (§4.3). ~2h.

**Sprint 2 (Cross-Service-Robustheit):**
5. Bidirektionale Contract-Tests (§4.2). ~1 Tag.
6. Tool-Inventory-Drift-Wächter Erweiterung (§4.4). ~30min.
7. PRE-GOLIVE §1.9 (Lazy-Migration v1→v2 für Blob-Pfad).
8. PRE-GOLIVE §6.6 (Embed-Salt Cross-User-Inference).

**Sprint 3 (Drills + Operator):**
9. PRE-GOLIVE §9.1-§9.4 Backup-Restore-Drill.
10. PRE-GOLIVE §1.6 KMS-Master-Rotation-Drill.
11. PRE-GOLIVE §7g.1-§7g.4 E2E mit claude.ai + MCP-Inspector.

**Gesamtaufwand zur Schliessung der akuten Lücken:** ~5-6 Arbeitstage.

---

## §7 Test-Strategie-Prinzipien (Drei-Punkt-Konvention)

1. **Jeder Tool-Wrapper braucht mindestens eine Integration-Test-Zeile.**
   Sanity reicht nicht. Wenn ein Tool nicht testbar ist (DB unavoidable
   o.Ä.) gehört es nicht in die User-Surface.

2. **Jede Wire-Schema-Änderung braucht einen Contract-Test.** Sensitivity-
   Werte, Output-Field-Names, displayTemplate-Format. Diese sind die
   stillsten Drift-Quellen.

3. **Jede Migration die Daten-Format ändert braucht einen Restore-Drill
   PLUS einen Roundtrip-Test mit altem + neuem Format.** Lazy-Migrations
   sind besonders riskant.

Diese drei Prinzipien sind die Mindest-Schwelle. Alles darüber ist
Bonus.

---

## §8 Was dieses Doku nicht ist

- **Keine Test-Implementierung.** Konkrete Test-Code-Spec gehört in die
  jeweiligen `tests/`-Files oder PRE-GOLIVE.
- **Keine Akzeptanz-Matrix.** Die ist in
  [PRE-GOLIVE-TESTPLAN.md](PRE-GOLIVE-TESTPLAN.md).
- **Keine Tool-by-tool-Spec.** Die ist im jeweiligen `src/mcp/tools/`-File
  und in den Plan-Files.

Dieses Doku ist **Test-Architektur** — welche Schichten gibt es, was
leistet jede, wo sind die akuten Lücken, was schreiben wir als nächstes.

---

## Cross-Refs

- [PRE-GOLIVE-TESTPLAN.md](PRE-GOLIVE-TESTPLAN.md) — Akzeptanz-Matrix mit
  200+ konkreten Test-Items
- [docs/plans/active/PLAN-tool-surface-as-storage-canonical.md](../plans/active/PLAN-tool-surface-as-storage-canonical.md)
  — Wrapper-Migration-Sprint-Doku
- [docs/runbooks/runbook-integration-tests.md](../runbooks/runbook-integration-tests.md)
  — Wie testcontainers laufen
- [scripts/smoke.sh](../../scripts/smoke.sh) — Layer-3 Smoke
- approval2-Side: [mcp-approval2/docs/plans/active/PLAN-tool-surface-cleanup.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-tool-surface-cleanup.md)
