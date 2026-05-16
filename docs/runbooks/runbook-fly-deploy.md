# Runbook — Operate `mcp-knowledge2` on Fly.io

> **Audience**: on-call operator. Steps are copy-pasteable, idempotent
> where safe, destructive operations explicitly marked.

## Quick reference

| Task | Command |
|---|---|
| Deploy a new release | `fly deploy --config fly.toml --remote-only` |
| Tail logs | `fly logs -a mcp-knowledge2` |
| Open VM shell | `fly ssh console -a mcp-knowledge2` |
| Postgres shell | `fly postgres connect -a mcp-knowledge2-pg` |
| List releases | `fly releases list -a mcp-knowledge2` |
| Rollback to prev | `fly releases rollback <version> -a mcp-knowledge2` |
| Set/rotate secret | `fly secrets set --app mcp-knowledge2 KEY=value` |
| Show secret names | `fly secrets list -a mcp-knowledge2` |
| Show machines | `fly machines list -a mcp-knowledge2` |
| Restart all machines | `fly machines restart -a mcp-knowledge2` |
| Scale horizontally | `fly scale count N -a mcp-knowledge2` |
| Scale vertically | `fly scale vm shared-cpu-2x --memory 1024 -a mcp-knowledge2` |

## Initial deploy

See [`deploy/fly/README.md`](../../deploy/fly/README.md) and run
`bash deploy/fly/deploy.sh`.

## Re-deploy after a code change

```bash
git pull
# Smoke locally if you can (npm test && npm run typecheck)
fly deploy --config fly.toml --remote-only
```

The `release_command = "npm run db:migrate"` runs **before** traffic is
swapped. If migrations fail, the release is aborted and the previous
release keeps serving traffic — no manual rollback needed.

## Rollback

```bash
fly releases list -a mcp-knowledge2
# Identify the last-known-good version (e.g. v23)
fly releases rollback v23 -a mcp-knowledge2
```

Rollbacks re-use the previously-deployed image — **no rebuild, no
re-migration**. If the bad release did a forward-incompatible
migration, you must restore from backup instead (see below).

## Scale

### Horizontal (more app instances)

```bash
fly scale count 2 -a mcp-knowledge2     # 2 replicas in fra
fly scale count 2 --region fra,ams -a mcp-knowledge2  # multi-region
```

The Hono app is stateless except for the JWKS cache and pg pool — safe
to run N replicas. The pg pool sizing (`DATABASE_POOL_MAX=10`) means
each replica holds up to 10 connections; tune both values together so
N × DATABASE_POOL_MAX ≤ Postgres `max_connections` (default 300 on
Fly's shared-cpu-1x pg cluster).

### Vertical (bigger VM)

```bash
fly scale vm shared-cpu-2x --memory 1024 -a mcp-knowledge2
```

Memory-heavy operations: embedding requests buffer the response body
(small) and the FTS+vector RRF join holds intermediate rows in memory
(`limit×3` rows from each side). Bump memory before bumping cpus.

### Scaling Postgres

```bash
fly postgres list
fly postgres update --vm-size shared-cpu-2x --memory 1024 -a mcp-knowledge2-pg
# Add a replica (HA):
fly machines clone <leader-machine-id> -a mcp-knowledge2-pg --region fra
```

Volume size can only grow:

```bash
fly volumes extend <volume-id> -s 10   # grow to 10 GB
```

## Secrets rotation

| Secret | Rotate when | How |
|---|---|---|
| `SERVICE_TOKEN` | Anyone outside the trust boundary saw it | `fly secrets set SERVICE_TOKEN=$(openssl rand -hex 32) -a mcp-knowledge2` + update any caller |
| `MCP_APPROVAL_INTERNAL_TOKEN` | Same as above | Rotate on both `mcp-approval2` and `mcp-knowledge2` atomically (deploy approval first, then knowledge2 — brief window of stale token rejected with 401 from approval) |
| `BACKUP_MASTER_KEY` | **NEVER** unless you accept that all old backups become un-decryptable | If you must: keep the old key in a separate vault, write a migration script that decrypts with old + re-encrypts with new |
| `DATABASE_URL` / `DATABASE_ADMIN_URL` | Postgres password rotation | `ALTER ROLE knowledge_app PASSWORD '<new>'` in pg, then `fly secrets set DATABASE_URL=… -a mcp-knowledge2` |
| `VERTEX_SERVICE_ACCOUNT_JSON` | Quarterly, or on suspicion (only when `EMBED_PROVIDER=vertex`) | New SA key in GCP, then `doppler secrets set VERTEX_SERVICE_ACCOUNT_JSON="$(cat new.json \| tr -d '\n')" --project mcp-knowledge2 --config privat --silent` + `bash deploy/fly/sync-secrets.sh` |
| `CLOUDFLARE_API_TOKEN` | Quarterly, or on suspicion (default embedding path) | New token in CF Dashboard mit `Workers AI Read` + `AI Gateway Run` scopes, dann `doppler secrets set CLOUDFLARE_API_TOKEN=… --project mcp-knowledge2 --config privat --silent` + sync |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Nur wenn AI Gateway im Authenticated-Mode läuft | `Regenerate token` im CF Dashboard → AI Gateway → Settings; dann Doppler-Update wie oben + sync |
| `ALLOWED_EMAILS` | On personnel change | `doppler secrets set ALLOWED_EMAILS=email1,email2 --project mcp-knowledge2 --config privat --silent` + sync |

Secrets-rotation triggers an app restart automatically.

## Postgres backup & restore

### Built-in cron (handled by the app)

The app runs a daily `pg_dump --format=custom` at 03:00 UTC, encrypts
it with `BACKUP_MASTER_KEY`, and uploads to `s3://${BACKUP_BUCKET}/backup/<ts>.dump.enc`.
Retention: `BACKUP_RETENTION_DAYS` (default 30).

### Fly's snapshot layer (additional, free)

Fly Postgres takes automatic volume snapshots — list and restore via:

```bash
fly volumes list -a mcp-knowledge2-pg
fly volumes snapshots list <volume-id>
# Restore happens by creating a new volume from a snapshot, then promoting
# the new machine. See Fly docs:
# https://fly.io/docs/postgres/managing/restore/
```

### Manual disaster restore (app-level backup)

1. Pick the backup file:
   ```bash
   aws s3 ls s3://${BACKUP_BUCKET}/backup/ | sort | tail
   ```
2. Download:
   ```bash
   aws s3 cp s3://${BACKUP_BUCKET}/backup/2026-05-13T03-00-00.dump.enc ./b.enc
   ```
3. Decrypt — TBD restore script lives in
   `scripts/restore-backup.ts` (placeholder; uses `BACKUP_MASTER_KEY`
   from your secret vault, NOT from the app's env).
4. `pg_restore --dbname=knowledge --clean --no-owner b.dump`

## Monitoring & alerts

- `/health` → liveness (200 if process is up)
- `/health/ready` → readiness (200 only if db + blob + JWKS reachable)
- `/metrics` → Prometheus, scraped by Fly automatically; visible in
  the Fly dashboard's metrics tab.
- Audit log → `audit_events` table in Postgres. Tail with:
  ```bash
  fly postgres connect -a mcp-knowledge2-pg
  -- inside psql:
  SELECT created_at, actor_user_id, action, object_id, ok
  FROM audit_events
  ORDER BY created_at DESC LIMIT 50;
  ```
- App logs (structured JSON via pino) → `fly logs -a mcp-knowledge2`,
  also queryable in the Fly dashboard.

## Failure modes & playbook

| Symptom | Likely cause | First action |
|---|---|---|
| `fly deploy` aborts in release_command | Migration broken | `fly logs -a mcp-knowledge2` filter on `release` — fix migration SQL, retry |
| Health check failing | Either app crash or pg down | `fly machines list` → check status; `fly logs` for errors |
| `/health/ready` 503 with `db=down` | Postgres connection broken | `fly postgres connect` — if itself fails, `fly machines restart -a mcp-knowledge2-pg` |
| `/health/ready` 503 with `jwks=down` | mcp-approval2 unreachable | Check mcp-approval2 status; verify `JWKS_URL` in `fly secrets list` |
| 401 from `/v1/*` | JWT signature mismatch (key rotation lag) | Wait for JWKS cache TTL (24h) or force restart: `fly machines restart -a mcp-knowledge2` |
| 401 from `/v1/internal/*` | `SERVICE_TOKEN` mismatch | Verify on the caller side, re-set with `fly secrets set` |
| Slow searches | Vector index missing or stale | `fly postgres connect`; check `\d objects` for `ivfflat` / `hnsw` index; `REINDEX` |
| OOM kills | Memory leak or oversized payload | Check `/metrics` for `process_resident_memory_bytes`; consider `fly scale vm --memory 1024` |

## Disable / pause the service

```bash
# Stop all machines (cost: ~$0 for the app, pg keeps running)
fly machines stop --select all -a mcp-knowledge2

# Re-enable
fly machines start --select all -a mcp-knowledge2
```

## Tear-down (DESTRUCTIVE — irreversible)

> **This will permanently delete all user data unless you have a recent
> encrypted backup safely off-Fly.** Do not run on a real customer
> environment without explicit written authorisation.

```bash
fly apps destroy mcp-knowledge2
fly apps destroy mcp-knowledge2-pg
```

## See also

- [`deploy/fly/README.md`](../../deploy/fly/README.md) — initial deploy
- [`docs/SECURITY.md`](../SECURITY.md) — threat model + key rotation policy
- [`docs/CROSS-SERVICE-CONTRACT.md`](../CROSS-SERVICE-CONTRACT.md) —
  what `mcp-knowledge2` expects from `mcp-approval2`
- [`docs/PILOT-READINESS.md`](../PILOT-READINESS.md) — what's done,
  what's left for pilot
