# Vulnerability-Fix-Plan (mcp-knowledge2)

> **Status:** Draft 2026-05-15.
> **Audit:** `npm audit` zeigt 11 Treffer, 1 high + 10 moderate.

## Vulnerability-Inventar

| Package | Severity | Fix | Breaking | Production? | Notiz |
|---|---|---|---|---|---|
| **undici** | **HIGH** | testcontainers@11.14.0 | ja (major) | nein (dev — Integration-Tests) | transitiv via testcontainers |
| @testcontainers/postgresql | moderate | 11.14.0 | ja (major) | nein | direkt dev-dep |
| testcontainers | moderate | 11.14.0 | ja (major) | nein | parent |
| drizzle-kit | moderate | 0.18.1 | ja (major) | nein | via @esbuild-kit/esm-loader → esbuild |
| @esbuild-kit/core-utils | moderate | drizzle-kit@0.18.1 | ja | nein | via esbuild |
| @esbuild-kit/esm-loader | moderate | drizzle-kit@0.18.1 | ja | nein | via core-utils |
| esbuild | moderate | 0.28.0 | ja | nein | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — dev-server CORS |
| vite | moderate | vitest@4.1.6 | ja | nein (dev/build) | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) — path traversal |
| vite-node | moderate | vitest@4.1.6 | ja | nein | via vite |
| vitest | moderate | 4.1.6 | ja | nein (test) | via vite |
| @vitest/mocker | moderate | vitest@4.1.6 | ja | nein | via vite |

**Kein production-runtime HIGH** (im Gegensatz zu mcp-approval2 wo drizzle-orm SQL-Injection vor sich hat — siehe approval2-Plan). Hier ist HIGH (undici) dev-only via testcontainers.

Konkret: mcp-knowledge2 nutzt **drizzle-orm bereits in einer fixed-Version** (>= 0.45.2). Das wurde im AS-3-Sprint mit-aktualisiert oder war von Anfang an aktuell. Verifizieren mit `npm ls drizzle-orm`.

## Strategy: Drei-Schritt-Update

### Schritt 1 — testcontainers 11.14.0 (HIGH, dev-only Integration-Tests)

```bash
cd /workspaces/mcp-knowledge2
npm install -D testcontainers@^11.14.0 @testcontainers/postgresql@^11.14.0
```

**Verify:**
- `npm run build` (KC2 ist ein Server-Bundle, kein Web)
- `npm run lint`
- `npm test` (Unit-Tests — Integration brauchen Docker, hier sowieso skipped im Codespace)
- Wenn Docker verfügbar: Integration-Tests müssen grün bleiben (`docker ps` → Postgres-Container)

**Erwartete Breaking Changes:**
- testcontainers 10 → 11 hat API-Änderungen für `GenericContainer.withEnvironment()`, `.withCommand()`, `.withCopyContentToContainer()` möglicherweise neu/anders
- `PostgreSqlContainer` API check (`tests/integration/*.test.ts` aktuell als Setup nutzt es)

### Schritt 2 — vite + vitest auf 8.x / 4.x

```bash
npm install -D vite@^8.0.13 vitest@^4.1.6
```

**Verify:**
- `npm run build`
- `npm test`
- `vitest.config.ts` checken (falls vorhanden)

### Schritt 3 — drizzle-kit 0.18.1

```bash
npm install -D drizzle-kit@^0.18.1
```

**Hinweis:** mcp-approval2 bumpt auf `drizzle-kit@0.31.10`. mcp-knowledge2 hat nur `0.18.1` als fixAvailable laut audit — das ist ein älterer Fix-Pfad. Beide Repos sollten auf dieselbe drizzle-kit-Major-Version landen wenn möglich (0.31.x wäre konsistent). Verifizieren ob 0.31.x in knowledge2 läuft (`npm install -D drizzle-kit@^0.31.0` testen), sonst auf 0.18.1 bleiben.

**Verify:**
- `drizzle.config.ts` checken
- `npm run db:generate` / `drizzle-kit generate` läuft sauber

## Verifikations-Gates pro Schritt

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test` (Unit + Contract — Integration optional)
- [ ] `npm run typecheck`

## Rollback

Pro Schritt eigener Commit, Rollback via `git revert`.

## Definition of Done

- 0 high + 0 moderate Vulnerabilities laut `npm audit` ODER dokumentierte Akzeptanz für dev-only mit risk-rating
- Tests + Build grün
- 3 atomare Commits gepusht
