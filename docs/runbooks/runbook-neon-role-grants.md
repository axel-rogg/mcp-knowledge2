# Runbook: Neon-Role-Grants vor Phase-2-Migrations

> **Status:** OPEN (2026-05-18). Blockiert Auto-Deploy von Migs 0020/0025.
> **Owner:** axelrogg@gmail.com (Operator). Eingreifen vor naechstem `fly deploy`.

## Problem

Phase-2-Deploy (`fly deploy -a mcp-knowledge2`) failed im `release_command`:

```
✗ 0020_phase1_review_fixes.sql failed: permission denied for table users
```

Plus ein Folge-Versuch mit `DATABASE_ADMIN_URL`:

```
error: permission denied for schema public
```

## Root-Cause

Neon-Roles `knowledge_app` + `knowledge_admin` haben unterschiedliche Privilegien — beide unvollstaendig fuer die Phase-2-Migrations:

| Role | DB-Owner | USAGE public | REFERENCES users | Wozu im Code |
|---|---|---|---|---|
| `knowledge_app` | ✅ ja | ✅ ja | ❌ **fehlt** | Runtime (RLS-bound), Migrations bisher |
| `knowledge_admin` | ❌ nein | ❌ **fehlt** | ❌ unklar | Admin-Tx (BYPASSRLS), Bootstrap |

Mig 0006 (`0006_users_and_invites.sql`) macht `REVOKE ALL ON users FROM knowledge_app` + `GRANT SELECT, INSERT, UPDATE ON users TO knowledge_app` — explizit ohne REFERENCES. Damit kann `knowledge_app` keine FK-Constraints `REFERENCES users(id)` mehr anlegen, wie Mig 0020 / 0025 sie brauchen.

`knowledge_admin` hat im Neon-TF-Setup keine USAGE auf Schema `public` — d.h. selbst CREATE TABLE failed.

## Lösung (Operator-One-Time)

Vor dem nächsten `fly deploy` (oder `npm run db:migrate`):

### Option A — minimal-invasive (empfohlen)

Schicke einen psql-Befehl gegen DATABASE_ADMIN_URL der nur die fehlende Privilegie ergaenzt:

```bash
# Aus mcp-approval2 (wo Doppler eingerichtet ist):
cd /workspaces/mcp-approval2
doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-knowledge2 --config fly | \
  xargs -I{} psql "{}" <<'EOF'
-- Grant REFERENCES on users to knowledge_app so FK-creating Migs work.
GRANT REFERENCES ON TABLE users   TO knowledge_app;
GRANT REFERENCES ON TABLE invites TO knowledge_app;
EOF
```

**Verifizieren:**

```bash
psql "$DATABASE_ADMIN_URL" -c "\dp users" | grep knowledge_app
# Expect: knowledge_app=arwxR/...
#                       ^ R = REFERENCES
```

### Option B — Neon-TF-Update (langfristig)

In [terraform/environments/privat/neon-knowledge2.tf] eine zusaetzliche `neon_permission`-Resource fuer REFERENCES anlegen. Beispiel:

```hcl
resource "null_resource" "knowledge_grants" {
  triggers = { db_id = neon_database.knowledge.id }
  provisioner "local-exec" {
    command = <<EOT
psql "${local.knowledge_admin_url}" <<SQL
GRANT REFERENCES ON TABLE users   TO knowledge_app;
GRANT REFERENCES ON TABLE invites TO knowledge_app;
SQL
EOT
  }
}
```

Nachteil: stateful, idempotent zu machen ist nervig. Option A ist robuster.

### Option C — Migration anpassen (Code-Path)

In Mig 0020 + 0025 die FK-Constraints durch TRIGGER-based Soft-References ersetzen. Mehr Code-Aenderungen, weniger Operator-Pflicht. Wenn das Repo wachsen soll und Neon-Roles nicht weiter touched werden, evtl. die richtige Antwort.

## Nach dem Operator-Fix

Re-deploy mit:

```bash
cd /workspaces/mcp-knowledge2
fly deploy --remote-only -a mcp-knowledge2
```

Migrations 0020–0026 sollten dann sauber durchgehen. `release_command` re-tried die Migrations idempotent (skipt 0019 da bereits in `_migrations` recorded).

## Cleanup falls Deploy v24/v25 partial blieb

Status pre-fix (von den 2 failed deploys 2026-05-18):
- Mig 0019 wurde angewendet (groups/group_members/share_grants Tabellen existieren)
- _migrations enthaelt '0019_groups_and_sharing_phase1.sql'
- Mig 0020+ NICHT angewendet

Falls 0019 NICHT idempotent ist (z.B. wegen DEFAULT-Werten oder Index-Konflikten), pruefe vor Re-Deploy:

```bash
psql "$DATABASE_ADMIN_URL" -c "SELECT name FROM _migrations ORDER BY name;"
# Expect bis 0019_groups_and_sharing_phase1.sql
```

## Cross-Reference

- [scripts/migrate.ts](../../scripts/migrate.ts) — Migration-Runner
- [drizzle/migrations/0020_phase1_review_fixes.sql](../../drizzle/migrations/0020_phase1_review_fixes.sql) — die FK-Constraints
- [drizzle/migrations/0006_users_and_invites.sql](../../drizzle/migrations/0006_users_and_invites.sql) — REVOKE ALL FROM knowledge_app
- [docs/runbooks/runbook-fly-deploy.md](./runbook-fly-deploy.md) — generischer Deploy-Flow
