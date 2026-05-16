# PLAN — Fly.io via Terraform (Hybrid)

> **Status:** ⚠️ **Code vorbereitet 2026-05-16, `terraform apply` pending User-Go.** Files liegen in `mcp-approval2/terraform/environments/privat/knowledge2-fly.tf` + `versions.tf` (Root + Privat) + `variables.tf` (Fly-Variables ergänzt) + `terraform.tfvars.example` (Fly-Block ergänzt). `deploy/fly/deploy.sh` hat den Schritt-1-Hinweis bekommen, dass TF die App-Existenz alternativ managen kann.
>
> **Update 2026-05-17:** Postgres ist nicht mehr auf Fly MPG, sondern auf **Neon Free Tier** (eu-central-1 Frankfurt), TF-managed via `kislerdm/neon`-Provider in `mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`. Neon Free kostet 0 €/mo (Fly MPG Basic war ~38 $/mo), pgvector + pg_trgm sind built-in, beide Rollen (`knowledge_app`, `knowledge_admin`) sind in Neons `neon_superuser`-Gruppe (BYPASSRLS, kein extra-GRANT-Step). DB-URLs (`DATABASE_URL` pooled, `DATABASE_ADMIN_URL` direct) + Passwords werden vom TF in Doppler `mcp-knowledge2 / fly` gepusht.
> **Owner:** Axel
> **Auslöser:** User-Frage „Kann man fly.io nicht auch mit terraform konfigurieren um uns Arbeit zu ersparen?" (2026-05-16). User-Entscheidung (2026-05-16): umsetzen.
> **Schwester-Strategie:** [STRATEGIE-pilot.md](../../STRATEGIE-pilot.md), [feedback_infra_via_terraform](https://github.com/axel-rogg/mcp-approval) (IaC-First-Linie)

## 1. Befund

Im Schwester-Repo [`mcp-approval2/terraform/`](https://github.com/axel-rogg/mcp-approval2/tree/main/terraform) existiert bereits ein produktiver TF-Stack mit Providern für Hetzner, Cloudflare, Google, Doppler (Stand 2026-05-16). Er provisioniert insbesondere den Doppler-Project-Trail für mcp-knowledge2 inkl. der 28 Secret-Placeholders im `privat`-Config (siehe `environments/privat/knowledge2-doppler.tf`), die Cloudflare-AI-Gateway-Resource `mcp-knowledge2` (`knowledge2-cloudflare.tf`), und Hetzner-Resources im Skeleton-Modul `modules/gcp-mcp-instance/`.

**Fly.io ist nicht im versions.tf** — es gibt keine Fly-Resource, kein knowledge2-fly.tf. Heute wird Fly ausschliesslich via [fly.toml](../../../fly.toml) + [deploy/fly/deploy.sh](../../../deploy/fly/deploy.sh) + flyctl gemanagt.

## 2. Coverage-Matrix

Der `fly-apps/fly`-Provider deckt ~60-70% des Fly-Setups ab:

### TF-managed (lohnt sich)

| Resource | TF-Provider | Was es ersetzt |
|---|---|---|
| `fly_app` (Existenz) | `fly_app` | `fly apps create` |
| `fly_volume` (3 GB persistent) | `fly_volume` | `fly volumes create` |
| `fly_ip` (v4/v6) | `fly_ip` | `fly ips allocate-v4 / -v6` |
| `fly_cert` (Custom-Domain TLS) | `fly_cert` | `fly certs add` |
| `fly_machine` (Compute-Instance) | `fly_machine` | `fly machines clone / start / scale` |

### NICHT TF-managed (flyctl bleibt)

| Operation | Warum nicht TF |
|---|---|
| Image-Build + Push | Kein Provider-Resource; `fly deploy` orchestriert Build + Image-Registry-Push |
| `release_command = "npm run db:migrate"` | fly.toml-Property, wird beim Deploy ausgelöst, nicht reine Infra |
| ~~`fly postgres create` + `fly postgres attach`~~ | **Obsolet seit 2026-05-17** — Postgres ist Neon-managed (`kislerdm/neon`-Provider, siehe `neon-knowledge2.tf`). Fly MPG (~38 $/mo) war für Solo-Pilot zu teuer. |
| Einmaliger Extension-Bootstrap (`CREATE EXTENSION vector; pg_trgm;`) | Erfordert psql-Connection, kein TF-Resource. Beide Neon-Rollen sind in `neon_superuser` → keine extra GRANTs nötig. |
| `fly secrets set` aus Doppler | Indirekt machbar mit `data "doppler_secrets"` + `fly_secret`-Resource, aber: Secret-Werte landen kurzzeitig im TF-State. **Sicherheitsthema** — der bestehende `sync-secrets.sh` (Doppler → Fly direkt, ohne State-File) ist sauberer. |

## 3. Realistische Ersparnis (ehrlich)

**Solo-Pilot:** Minimal. Infrastruktur wird **einmal** angelegt, dann nur noch Code via `fly deploy` iteriert. Setup-Aufwand ~½ Tag, Ersparnis ~5 min pro Operation, die selten passiert.

**Multi-Customer-Pilot** (jeder Customer eine eigene Fly-Instance): Signifikant. Pro Customer eigene Terraform-Workspace + `terraform.tfvars`. Drift-Detection. Reproduzierbar. Hier holt sich der ½-Tag-Invest in 2-3 Customer-Stacks wieder rein.

**Konsistenz-Gewinn:** Hetzner, Cloudflare, Doppler sind alle in TF. Fly als einziger Outlier ist ein langfristiger Code-Smell (Mental-Model-Split). Auch wenn die Stunden-Ersparnis klein ist, der Wartungs-Komfort steigt.

## 4. Empfehlung — pragmatischer Hybrid

Ein neues File `mcp-approval2/terraform/environments/privat/knowledge2-fly.tf` mit den **stabilen** Fly-Resources. Image-Build + Deploy + Postgres bleiben bei flyctl.

```hcl
# Pseudo-Code, nicht produktionsfertig — als Diskussionsgrundlage.

resource "fly_app" "knowledge2" {
  name = "mcp-knowledge2"
  org  = "personal"  # oder dedicated org slug
}

resource "fly_volume" "knowledge2_pg" {
  app    = fly_app.knowledge2.name
  name   = "mcp_knowledge2_pg_data"
  region = "fra"
  size   = 3
}

resource "fly_ip" "knowledge2_v4" {
  app  = fly_app.knowledge2.name
  type = "v4"
}

resource "fly_ip" "knowledge2_v6" {
  app  = fly_app.knowledge2.name
  type = "v6"
}

# Optional, wenn Custom-Domain gewünscht:
# resource "fly_cert" "knowledge2_custom" {
#   app      = fly_app.knowledge2.name
#   hostname = "knowledge.ai-toolhub.org"
# }

output "knowledge2_fly_app_id" {
  value = fly_app.knowledge2.id
}
```

Plus in `versions.tf`:

```hcl
fly = {
  source  = "fly-apps/fly"
  version = "~> 0.0.23"  # aktuelle Version zum Zeitpunkt prüfen
}
```

Was **nicht** in TF kommt:

- ~~`fly_postgres_cluster`~~ — entfällt; Postgres ist seit 2026-05-17 Neon-managed via `kislerdm/neon`-Provider in `neon-knowledge2.tf`
- `fly_machine` für die App-Instance — bleibt `fly deploy` (weil Image-Build inhärent imperativ)
- Doppler-Secret-Mirror — bleibt `bash deploy/fly/sync-secrets.sh` (kein TF-State-Risiko für Secret-Werte)
- `release_command` — bleibt fly.toml

## 5. Risiken

- **Provider-Maturity:** `fly-apps/fly` ist Community-grade. Einige Edge-Cases (Volume-Resize, Multi-Region) funktionieren nicht oder erfordern Provider-Workarounds.
- ~~**Fly-Postgres-Deprecation**~~ — entfällt, weil Postgres seit 2026-05-17 auf Neon liegt.
- **Neon-TF-Gotcha:** TF-Locals müssen die Hosts via `neon_project.<name>.database_host[_pooler]` Resource-Attribute auslesen, **nicht** aus `default_branch_id` + `region_id` konstruieren. Der konstruierte Pattern produziert DNS-unresolvable Hosts; das echte Pattern ist `ep-<name>.c-N.<region>.aws.neon.tech` und nur das Resource-Attribute liefert das korrekt.
- **Neon-Free-Tier-Limits:** `history_retention_seconds` max 21600 (6 h), kein `suspend_timeout_seconds`-Override (Auto-Suspend on idle, ~300 ms Cold-Start). Reicht für Solo-Pilot, vor Customer-Volumen Upgrade auf Launch evaluieren.
- **State-Drift:** Wenn jemand `fly apps create` manuell ausführt + TF dann das gleiche versucht → Konflikt. Mitigation: TF-Apply zuerst, danach nur noch flyctl für Deploy-Ops.
- **Token-Scope:** `FLY_API_TOKEN` für TF muss `Org admin` oder zumindest `Apps deploy` haben. Aktuell hat der flyctl-CLI-Login einen User-Token, der nicht direkt re-usable ist als TF-Token — `fly auth token` extrahieren.

## 6. Implementations-Phasen

| Phase | Was | Status |
|---|---|---|
| 0 | `fly-apps/fly`-Provider in `versions.tf` (Root + Privat) ergänzen, `fly_org`-Variable in `variables.tf`, `terraform.tfvars.example` Fly-Block | ✅ 2026-05-16 |
| 1 | `knowledge2-fly.tf` mit `fly_app` + `fly_ip` (v6, free) + Outputs — dedicated IPv4 bewusst weggelassen (shared-v4 reicht für Pilot, spart $2/mo) | ✅ 2026-05-16 |
| 2 | `terraform plan` gegen User's Doppler-Workspace + FLY_API_TOKEN — sieht aus wie 2 frische Resources (app + ipv6) | ⏳ pending User: `export FLY_API_TOKEN=$(fly auth token)` + `bash scripts/doppler-run-terraform.sh plan -target=fly_app.knowledge2 -target=fly_ip.knowledge2_v6` |
| 3 | `terraform apply` → Fly-App + IPv6 existieren | ⏳ pending User-Go |
| 4 | `deploy/fly/deploy.sh` annotated: Schritt 1 skippt sauber wenn App existiert (TF- oder flyctl-managed) | ✅ 2026-05-16 |
| 5 | Doku-Update: STRATEGIE-pilot.md + dieser PLAN auf „Code vorbereitet" | ✅ 2026-05-16 |
| 6 | Smoke nach erstem End-to-End-Deploy via TF-managed App | ⏳ pending erster echter Deploy |

**Verbleibender Aufwand: ~15 min für `plan` + `apply`.** Alles andere ist code-only und bereits vorbereitet.

## 7. Alternative: Status Quo behalten

Wenn die Solo-Pilot-Linie wirklich nur 1-2 Customer-Instances bedienen wird und die Mental-Model-Inkonsistenz akzeptabel ist, ist der Status Quo (fly.toml + flyctl, kein TF für Fly) **nicht falsch**. Memory `feedback_infra_via_terraform.md` ist die Default-Linie, aber sie hat dokumentierte Ausnahmen (provider unterstützt nicht, einmalige Operations, etc.).

Wir können den Plan hier als „erledigt sobald ein zweiter Customer kommt"-Followup parken — analog zu PLAN-dual-runtime.md geparkter Status.

## 8. Stand 2026-05-16: Code vorbereitet

User-Entscheidung (2026-05-16): **Variante 1, jetzt umsetzen.** Code-Phase 0+1+4+5 ist erledigt. Verbleibend: `terraform plan` reviewen und ggf. `apply` ausführen — das schafft die echten Fly-Resources und wird dem User überlassen.

**Konkreter Apply-Pfad:**

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat
export FLY_API_TOKEN=$(fly auth token)
bash ../../../scripts/doppler-run-terraform.sh init
bash ../../../scripts/doppler-run-terraform.sh plan \
  -target=fly_app.knowledge2 \
  -target=fly_ip.knowledge2_v6 \
  -out=/tmp/fly.tfplan
# Review the plan, then:
bash ../../../scripts/doppler-run-terraform.sh apply /tmp/fly.tfplan
```

**Falls die App schon via `fly apps create` existiert (z.B. vorheriger deploy.sh-Lauf):** Import statt Create:

```bash
bash ../../../scripts/doppler-run-terraform.sh import fly_app.knowledge2 mcp-knowledge2
# Dann plan + apply wie oben — sollte „no changes" sagen
```

Danach: `bash deploy/fly/deploy.sh` (im mcp-knowledge2-Repo) — Schritt 1 sieht App existiert, skippt, macht weiter mit Postgres + Secrets + Deploy.

## 9. Referenzen

- [`fly-apps/fly` Terraform-Provider](https://registry.terraform.io/providers/fly-apps/fly/latest/docs)
- [`mcp-approval2/terraform/environments/privat/knowledge2-doppler.tf`](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/knowledge2-doppler.tf) — existierender TF-Trail für mcp-knowledge2 (Doppler)
- [`mcp-approval2/terraform/environments/privat/knowledge2-cloudflare.tf`](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/knowledge2-cloudflare.tf) — AI-Gateway-Resource
- [STRATEGIE-pilot.md](../../STRATEGIE-pilot.md) — aktive Pilot-Linie
- [PILOT-READINESS.md](../../PILOT-READINESS.md) — Sign-off-Checkliste
- [feedback: Infra via Terraform](https://github.com/axel-rogg/mcp-approval/blob/main/CLAUDE.md#infrastructure-policy) — Default IaC-Linie
