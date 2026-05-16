# Runbook — AS-3 Big-Bang Cutover Day

> **Status: ⚠️ SPEC — pre-cutover, 2026-05-15**
>
> This is the operator-facing step-by-step for the day mcp-approval2 + mcp-knowledge2
> swap to the AS-3 auth model. Plan-side reference: [PLAN-as3-bigbang.md](../plans/active/PLAN-as3-bigbang.md) §5.
>
> The runbook assumes: pilot-stage Hetzner stack
> (`deploy/hetzner/docker-compose.yml` in mcp-approval2 repo, both services
> co-located). Adjust paths for Fly/Cloud-Run/etc.

---

## 0. Why a runbook (not just "merge + deploy")?

AS-3 swaps the trust model between approval2 and KC2 in both directions:
- approval2 stops being KC2's IdP; signs OBO-JWTs instead.
- KC2 stands up its own DCR-OAuth-Facade for the Claude.ai-direct path.
- Both services gain their own users table + KMS-adapter.

There is **no graceful in-place migration** — Tier-0 to Tier-2 of the
implementation-plan landed dual-write/dual-read code-paths. The day-zero
script below is what actually flips them.

---

## 1. Pre-Cutover (T-7 to T-1)

### 1.1 Tooling readiness (T-7)

- [ ] Both branches `feat/as3-cutover` in CI green on:
  - `npm run typecheck` (both repos)
  - `npm run test` (both repos)
  - approval2: `npm test` workspace-wide ≥ 645 tests passing
  - knowledge2: `npm run test:unit` + `npm run test:integration` (Testcontainers)
- [ ] `bash scripts/smoke.sh` (approval2) green on Hetzner pilot
- [ ] Cross-service contract suites green on both sides:
  - knowledge2: `tests/contract/{obo-jwt,user-sync,mcp-tools-list,oauth-self-token}.test.ts`
  - approval2: `apps/server/tests/contract/{kc-tools-call,kc-proxy-forward,manifest-roundtrip}.test.ts`

### 1.2 Google-OAuth-Setup (T-3)

Two separate Web-App Client-IDs in Google Cloud Console
(https://console.cloud.google.com/apis/credentials):

- [ ] **approval2-Client** (existing, verify):
  - Authorized JS Origins: `https://approval2.<domain>`, `http://localhost:8787`
  - Redirect URIs: `https://approval2.<domain>/oauth/google/callback`, `http://localhost:8787/oauth/google/callback`
- [ ] **knowledge2-Client** (new):
  - Authorized JS Origins: `https://knowledge.<domain>`, `http://localhost:8080`
  - Redirect URIs: `https://knowledge.<domain>/auth/google/callback`, `http://localhost:8080/auth/google/callback`
- [ ] OAuth-Consent-Screen scopes: `openid email profile`
- [ ] Test-user-allowlist contains all pilot users (else 400 from Google)
- [ ] Optional `GOOGLE_HD_ALLOWLIST` (CSV) ready for Workspace-pinning

### 1.3 KMS-Setup (T-3) — Google Cloud KMS

> **2026-05-17 Update:** OpenBao-Path wurde durch Google Cloud KMS ersetzt
> ([mcp-approval2 ADR-0011](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/adr/0011-cloud-kms-kek-provider.md)).
> KC2 nutzt seinen [`CloudKmsKms`-Adapter](../../src/adapters/kms/cloud_kms.ts)
> (war schon vorhanden, jetzt Default). OpenBao bleibt im Repo als alternative
> Selfhosting-Variante dokumentiert, ist aber nicht mehr Default-Pfad und
> erfordert wenn aktiviert Offline-Unseal-Key-Storage.

**TF-Apply (im Schwester-Repo):**

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat
gcloud auth application-default login    # 1× pro Maschine
bash ../../../scripts/doppler-run-terraform.sh apply
```

Das legt für KC2 automatisch an:
- Service-Account `mcp-knowledge2-fly@axelrogg-ai-tools.iam.gserviceaccount.com`
- `roles/cloudkms.cryptoKeyDecrypter`-Binding auf `projects/axelrogg-ai-tools/locations/eu/keyRings/mcp-approval2-privat/cryptoKeys/user-dek-master`
- Doppler-Secrets in `mcp-knowledge2/privat`-Config:
  - `KMS_PROVIDER=cloud_kms`
  - `CLOUD_KMS_KEY_NAME` (full resource path)
  - `CLOUD_KMS_WRAPPED_MASTER_B64` (base64-ciphertext des 32-byte Master-Keys)
  - `GOOGLE_APPLICATION_CREDENTIALS_JSON` (SA-Key)

**Verifikation:**

```bash
# Im KC2-Container nach Deploy:
fly logs -a mcp-knowledge2 | grep "unwrapping master key via Cloud KMS"
# → "Successful KMS decrypt on first DEK-resolution call"
```

- [ ] `gcloud kms keys versions list --location=eu --keyring=mcp-approval2-privat --key=user-dek-master --project=axelrogg-ai-tools` zeigt aktive Version
- [ ] Cloud Logging Audit-Trail: erste `Decrypt` Operation vom Service-Account sichtbar
- [ ] Falls Fallback nötig: `KMS_PROVIDER=hkdf_local` in Doppler setzen + `MASTER_KEY_B64` befüllen → Service-Restart

**OpenBao-Path (geparkt, nicht für Default-Cutover):** falls jemals Selfhost-Switch nötig, siehe [`mcp-approval2/terraform/environments/privat-openbao/README.md`](https://github.com/axel-rogg/mcp-approval2/tree/main/terraform/environments/privat-openbao) — komplettes TF-Modul plus Offline-Key-Storage-Anforderung.

### 1.4 Domain + TLS (T-3)

- [ ] DNS A/AAAA records for `approval2.<domain>` + `knowledge.<domain>` point at Hetzner VM
- [ ] Caddyfile updated (rendered via `deploy/hetzner/render-config.sh`) — both vhosts present
- [ ] TLS-Cert pre-fetched OR Caddy will fetch on first hit (Let's Encrypt; verify no rate-limit window)

### 1.5 Secrets inventory (T-2)

**Two Doppler-Projects, each with `privat` config:**
- `mcp-approval2` — approval2-Service-Secrets (provisioned via `terraform/environments/privat/doppler.tf`)
- `mcp-knowledge2` — KC2-Service-Secrets (provisioned via `terraform/environments/privat/knowledge2-doppler.tf`)

Beide TF-Files leben im **mcp-approval2-Repo** (`terraform/environments/privat/`). Placeholders sind automatisch angelegt; folgende Werte müssen befüllt sein:

**Cross-Service (gleicher Wert in beiden Projects):**

| Secret | Source | Owner |
|---|---|---|
| `MCP_KNOWLEDGE_SERVICE_TOKEN` (approval2) = `SERVICE_TOKEN` (knowledge2) | `openssl rand -hex 32` | Identischer Wert in beiden |

**approval2-only:**

| Secret | Source | Owner |
|---|---|---|
| `JWT_RS256_PRIVATE_KEY_PEM` + `JWT_RS256_PUBLIC_KEY_PEM` | `deploy/hetzner/generate-secrets.sh` | Verify rotated |
| `JWT_KID` | freeform string with date-stamp | `key-2026-MM-DD` |
| `GOOGLE_OAUTH_CLIENT_ID` + `_SECRET` | approval2 Google project | Operator |
| `VAULT_TOKEN` | OpenBao root or AppRole-issued | Existing |

**knowledge2-only:**

| Secret | Source | Owner |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` + `_SECRET` (separate KC2 OAuth-App) | knowledge2 Google project | Operator |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://knowledge2.<domain>/auth/google/callback` | TF-default in dev |
| `SELF_OAUTH_ISSUER` | `https://knowledge2.<domain>` | Operator |
| `ALLOWED_EMAILS` | CSV der erlaubten Login-Emails | Operator — strict whitelist on KC2's `/auth/google/callback` |
| `CLOUDFLARE_ACCOUNT_ID` | CF Dashboard URL | Public — kopiert von approval2/fly (legacy: approval2/privat) |
| `CLOUDFLARE_API_TOKEN` | CF API Tokens — `Workers AI Read` + `AI Gateway Run` | Operator — copy from approval2 ok wenn Permissions stimmen |
| `CLOUDFLARE_AI_GATEWAY_ID` | Auto via `cloudflare_ai_gateway.knowledge2` TF-Resource | TF-managed |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Optional — nur bei Authenticated Gateway | Operator |
| `EMBED_PROVIDER` | `cloudflare` (Workers AI bge-m3, default) oder `vertex` | TF-default |
| `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64` = `BACKUP_MASTER_KEY` | `openssl rand -base64 32` | knowledge2-only |
| `BLOB_ACCESS_KEY` + `BLOB_SECRET_KEY` + `BLOB_BUCKET` + `BLOB_ENDPOINT` | S3 provider (Tigris/R2/B2/Hetzner) | New |
| `KMS_PROVIDER` | `openbao` (prod) oder `hkdf_local` (dev) | Operator |
| `KMS_MASTER_KEY_B64` | `openssl rand -base64 32` — nur bei hkdf_local | Operator |
| `DATABASE_URL` + `DATABASE_ADMIN_URL` | aus VM-setup.sh oder external Postgres | Operator |

**Pflicht-Checks vor T+0:**
- [ ] `MCP_KNOWLEDGE_SERVICE_TOKEN` (approval2) == `SERVICE_TOKEN` (knowledge2) — Byte-exakt identisch
- [ ] `terraform output knowledge2_doppler_dashboard` zeigt die UI mit allen Placeholders gefüllt
- [ ] Cloudflare API-Token Permissions verifiziert via `curl …/ai/run/@cf/baai/bge-m3` (returns `success:true` mit 1024-dim Vektor)
- [ ] Falls Hetzner-VM bare-metal: `bash deploy/hetzner/generate-secrets.sh > /tmp/.env.new && diff` (sonst alles via Doppler)

### 1.6 Rollback-Snapshot (T-1)

- [ ] Tag both repos: `git tag pre-as3-cutover && git push origin pre-as3-cutover` (in both)
- [ ] Postgres backup: `docker compose exec postgres pg_dumpall -U postgres > /backup/pre-as3-$(date +%F).sql`
- [ ] OpenBao snapshot: `bao operator raft snapshot save /backup/openbao-pre-as3-$(date +%F).snap`
- [ ] R2/S3-Backup copy of `mcp-approval2-backup/` and `knowledge2-backup/` to offline storage

---

## 2. Cutover Day (T+0 to T+90)

**Operator at the keyboard. Window: 90 minutes + 30-60 min debug buffer.**
Reihenfolge: KC2 zuerst (approval2 läuft graceful ohne KC2).

```bash
# Working directory throughout: deploy/hetzner/ in mcp-approval2 repo.
cd /workspaces/mcp-approval2/deploy/hetzner
```

### T+0 — Window open

```bash
# 1. Stop the pilot stack (graceful — wait for in-flight requests).
docker compose down --timeout 30

# 2. Verify both services are off.
docker ps | grep -E "mcp-approval2|mcp-knowledge2"   # must be empty
```

### T+5 — Merge KC2 branch

```bash
cd /workspaces/mcp-knowledge2
git fetch origin
git checkout main
git merge --ff-only origin/feat/as3-cutover
# If not fast-forward: investigate, do NOT force.
git push origin main
```

### T+10 — KC2 Migrations

Run the new migrations against the knowledge2 DB:

```bash
# Start ONLY postgres first so migrations can run.
cd /workspaces/mcp-approval2/deploy/hetzner
docker compose up -d postgres
sleep 5  # wait for healthcheck

# Run KC2 migrations.
docker run --rm \
  --network mcp-internal \
  -e DATABASE_URL="postgres://app:${POSTGRES_PASSWORD}@postgres:5432/knowledge2" \
  -e DATABASE_ADMIN_URL="postgres://app:${POSTGRES_PASSWORD}@postgres:5432/knowledge2" \
  -v $(pwd)/../../mcp-knowledge2:/app -w /app \
  node:22 \
  bash -c "npm ci && npm run db:migrate"

# Verify users + invites + signing_keys + audit_log columns:
docker compose exec postgres psql -U app -d knowledge2 -c "\d users"
docker compose exec postgres psql -U app -d knowledge2 -c "\d invites"
docker compose exec postgres psql -U app -d knowledge2 -c "\d signing_keys"
docker compose exec postgres psql -U app -d knowledge2 -c "\d audit_log" | grep -E "via_proxy|approval_id"
```

Expected: all 4 tables/columns exist with the right shape.

### T+15 — Boot KC2

```bash
# Render Caddyfile (kc2 vhost now active) + pull new images.
bash render-config.sh
docker compose pull mcp-knowledge2
docker compose up -d mcp-knowledge2

# Wait for healthy.
until docker inspect --format='{{.State.Health.Status}}' mcp-knowledge2 | grep -q healthy; do
  echo "waiting for KC2 health..."; sleep 3
done
```

### T+20 — KC2 facade smoke

```bash
# Discovery doc — must be RFC-8414 conformant.
curl -fsS https://knowledge.<domain>/.well-known/oauth-authorization-server | jq .

# JWKS endpoint — must show 1+ active EdDSA key.
curl -fsS https://knowledge.<domain>/.well-known/jwks.json | jq .keys

# DCR — anonymous registration.
curl -fsS -X POST https://knowledge.<domain>/oauth/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"cutover-smoke","redirect_uris":["http://localhost:8888/cb"]}'
# Expect: {"client_id":"kc2_<uuid>", ...}
```

- [ ] Discovery doc returned 200 + valid JSON
- [ ] JWKS contains an active EdDSA key
- [ ] DCR-registration returned a `client_id`

### T+25 — KC2 first-login (admin-bootstrap)

```bash
# Open in browser (NOT in CLI — needs Google-consent UI).
xdg-open "https://knowledge.<domain>/oauth/authorize?response_type=code&client_id=<from-DCR>&redirect_uri=http://localhost:8888/cb&code_challenge=<sha256-of-verifier>&code_challenge_method=S256&scope=openid+email"
```

The operator:
1. Sign in with their Google account.
2. Approve consent.
3. Browser redirects to `http://localhost:8888/cb?code=...`.
4. Verify in DB:
   ```bash
   docker compose exec postgres psql -U app -d knowledge2 -c \
     "SELECT id, email, role, status FROM users WHERE role='admin';"
   ```
   Expect: 1 row with `role='admin'`, `status='active'`, your email.

- [ ] Operator user persisted as `admin`
- [ ] No 403 (would mean `email_verified=false` or `hd` allowlist mismatch)

### T+30 — Claude.ai direct smoke (autonomous path)

1. In Claude.ai → Settings → MCP Servers, add `https://knowledge.<domain>/mcp`.
2. Claude.ai walks through DCR + Auth-Code flow (browser pops up Google).
3. After auth: tools/list shows all KC2-tools (objects.*, shares.*, search).

- [ ] Claude.ai tools/list returns 11+ tools
- [ ] `objects.list` callable, returns empty list (RLS-context resolved)

### T+40 — Merge approval2 branch

```bash
cd /workspaces/mcp-approval2
git fetch origin
git checkout main
git merge --ff-only origin/feat/as3-cutover
git push origin main
```

### T+45 — Deploy approval2

```bash
cd deploy/hetzner
docker compose pull mcp-approval2
docker compose up -d mcp-approval2

# Wait for healthy.
until docker inspect --format='{{.State.Health.Status}}' mcp-approval2 | grep -q healthy; do
  echo "waiting for approval2 health..."; sleep 3
done
```

### T+50 — approval2 login smoke

1. Open `https://approval2.<domain>` in browser.
2. Sign in with Google.
3. Verify session cookie present (DevTools → Application → Cookies → `session_jwt`).
4. PWA loads with empty tools list (KC-wrappers should populate within 5 min via cron).

- [ ] Session cookie issued
- [ ] PWA boots without console errors

### T+55 — User-sync smoke (approval2 → KC2)

Trigger a user state change in approval2 (e.g. invite a 2nd user via admin
UI, or `bash deploy/hetzner/cli/invite.sh user@example.org`). Verify KC2
sees the new user:

```bash
docker compose exec postgres psql -U app -d knowledge2 -c \
  "SELECT id, email, status FROM users ORDER BY created_at DESC LIMIT 5;"
```

- [ ] New users row in KC2 with the right email + status

### T+60 — PWA Storage-Tab smoke

1. Open approval2 PWA → Storage tab.
2. Empty list expected (new KC2 DB).
3. DevTools Network tab: every call goes to `/admin/kc-proxy/v1/objects?...`
   with Authorization: Bearer (PWA session JWT) — server-side rewrites to
   Service-Token + OBO-JWT before forwarding to KC2.

- [ ] No 401/403 on storage list call
- [ ] Server logs show outbound calls to KC2 with `X-On-Behalf-Of` header

### T+65 — Claude.ai → approval2 smoke (proxy path)

1. In Claude.ai add `https://approval2.<domain>/mcp` (separate registration from KC2).
2. tools/list returns native tools + auto-generated `kc_wrappers/*` (= objects.*, search, shares.*).
3. Call a read-only KC wrapper (e.g. `objects.list`) — direct return, no approval needed.

- [ ] kc_wrappers visible in tools/list
- [ ] Read-only KC wrapper returns successfully

### T+70 — Approval-flow E2E

1. From Claude.ai: call a state-changing KC wrapper (e.g. `objects.create`).
2. Claude.ai gets an approval-prompt → user clicks Approve in PWA.
3. After approve: approval2 forwards to KC2 with `approval_id` in OBO claim.
4. Verify KC2 audit-log shows the trail:
   ```bash
   docker compose exec postgres psql -U app -d knowledge2 -c \
     "SELECT action, via_proxy, approval_id FROM audit_log ORDER BY id DESC LIMIT 5;"
   ```

- [ ] Audit-row with `via_proxy=true` AND `approval_id IS NOT NULL`

### T+80 — Sanity: stop approval2, KC2-direct still works

```bash
docker compose stop mcp-approval2
sleep 2

# Claude.ai-direct path against KC2 should still work.
curl -fsS -H "Authorization: Bearer <claude-ai-token>" \
  https://knowledge.<domain>/v1/objects | jq .
```

- [ ] KC2 responds 200 with valid object-list payload

### T+85 — Restore approval2, sanity that BOTH paths work

```bash
docker compose start mcp-approval2
sleep 10

# approval2 PWA must come up + auto-generated KC-wrappers re-attach.
curl -fsS https://approval2.<domain>/health | jq .
```

- [ ] Both services live, both paths green

### T+90 — Cutover-Window closed

- [ ] Update Plan-Files: `PLAN-as3-bigbang.md` + both `PLAN-as3-autonomous.md`
      Status banner → ✅ DEPLOYED
- [ ] CLAUDE.md (both repos) updated: "AS-3 live"
- [ ] Slack/Email-Ping to pilot users with the new auth flow notes

---

## 3. Rollback (T+? if any of the gates fail)

### 3.1 What triggers rollback

| Trigger | Action |
|---|---|
| KC2 fails to start after migration | Rollback KC2 only (see 3.2) |
| KC2 Google-OAuth blocked (redirect-loop / verify-fail) | Rollback KC2 only |
| approval2 KnowledgeAdapter throws 401/403 on EVERY call | Rollback approval2 only (KC2 stays for direct-path tests) |
| approval2 cron `kc-manifest-refresh` fails repeatedly | NO rollback — kc_wrappers degrade gracefully (empty list) |
| Approval-flow missing `approval_id` in OBO | NO rollback — hot-fix forward, audit gap is cosmetic |

### 3.2 Rollback procedure

```bash
# In approval2 repo:
cd /workspaces/mcp-approval2
git checkout pre-as3-cutover
git tag rollback-as3-$(date +%F)
git push origin rollback-as3-$(date +%F)

# In knowledge2 repo (if rolling back KC2 too):
cd /workspaces/mcp-knowledge2
git checkout pre-as3-cutover
git tag rollback-as3-$(date +%F)
git push origin rollback-as3-$(date +%F)

# Redeploy old images (TAG=<git-sha-of-pre-as3>).
cd /workspaces/mcp-approval2/deploy/hetzner
TAG=<old-sha> KNOWLEDGE_TAG=<old-sha> docker compose up -d
```

**DB migrations are NOT rolled back.** The new tables (`users`, `invites`,
`signing_keys`, plus `audit_log.via_proxy`, `audit_log.approval_id`) are
additive — they harm nothing in the old code-path (which simply ignores them).

After rollback:
- File a post-mortem issue with the failure-mode + recovery time.
- Schedule a second cutover-window once the bug is patched.

---

## 4. Post-Cutover (T+1 to T+7)

### Day 1

- [ ] Watch `mcp-knowledge2` + `mcp-approval2` container logs for an hour.
      Look for `"OBO jwt verify failed"`, `"jwt verify failed"`, `401`/`403`
      patterns at higher than baseline rate.
- [ ] CORS-errors in PWA-browser console = 0 (use real browser, not curl).
- [ ] Pilot users have re-registered their Claude.ai-MCP-clients (old DCR
      registration may be stuck; users may need to re-add the server).

### Day 1-3

- [ ] Token-refresh-flow tested by ≥1 user (login, wait > 1h, do action).
- [ ] PWA Storage-tab roundtrip: create object → list shows it → delete →
      list no longer shows it.
- [ ] User-sync race test: have 2 users log in simultaneously via Google →
      no `duplicate key` errors in approval2 or KC2 logs.
- [ ] Backup-cron ran (3 AM in deployments/docker-compose.yml schedule) →
      R2/S3 has a new encrypted dump.

### Day 7

- [ ] No regressions in audit-log: every row has either `actorUserId` resolved
      or `via_proxy=true` (no "anonymous" / null actor rows).
- [ ] Memory + DB-connections stable (`docker stats` snapshot daily).
- [ ] Update post-cutover status: PLAN files marked ✅ DEPLOYED, README
      banners updated.

After 7 days clean: the `pre-as3-cutover` tags can be archived (kept for
30 days, then deleted from origin per AS-3-Bigbang §8).

---

## 5. Open Operator Decisions

These get decided pre-T+0:

- **Cutover-Window time.** Default: 22:00-00:00 CET on a weekday. Pilot
  users notified 48h before.
- **OAuth-Consent-Screen state.** Google may put the second app
  (knowledge2-client) in pending-review for hours. If not approved by T+0:
  add pilot users to the test-user allowlist OR skip Direct-Path-Smoke
  until consent is in place. Proxy-Path still works (uses approval2's
  consent screen).
- **OpenBao master-key.** If `KMS_PROVIDER=hkdf_local` is acceptable for
  pilot, no OpenBao-AppRole-setup needed → 30 min saved. For prod, use
  OpenBao.

---

## 6. References

- Master plan: [PLAN-as3-bigbang.md](../plans/active/PLAN-as3-bigbang.md)
- KC2 spec: [PLAN-as3-autonomous.md (this repo)](../plans/active/PLAN-as3-autonomous.md)
- approval2 spec: [PLAN-as3-autonomous.md (mcp-approval2)](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-as3-autonomous.md)
- Cross-service contract tests (truth-source for wire-shapes):
  - mcp-knowledge2: `tests/contract/{obo-jwt,user-sync,mcp-tools-list,oauth-self-token}.test.ts`
  - mcp-approval2: `apps/server/tests/contract/{kc-tools-call,kc-proxy-forward,manifest-roundtrip}.test.ts`
- Deploy-Hetzner runbook: [runbook-deploy-hetzner.md](./runbook-deploy-hetzner.md)
- Fly-Deploy runbook: [runbook-fly-deploy.md](./runbook-fly-deploy.md)
