# Runbook: Integration Tests (mcp-knowledge2)

> Local + CI playbook for the Testcontainers-based integration test suite.
> Companion: [docs/CROSS-SERVICE-CONTRACT.md](../CROSS-SERVICE-CONTRACT.md).

---

## 1. What gets tested

| Suite                              | File                                              | Notes |
|------------------------------------|---------------------------------------------------|-------|
| RLS isolation                      | `tests/integration/rls.test.ts`                   | low-level SQL, hits `pg.Client` directly. Verifies row-level-security policies survive a forgetful application layer. |
| Adapter-shape roundtrip            | `tests/integration/objects-roundtrip.test.ts`     | spins up the **full Hono server**, calls every endpoint the `mcp-approval2` `KnowledgeAdapter` reaches. Mocks Vertex AI + KMS + blob-store. |

Both suites use [`@testcontainers/postgresql`](https://www.npmjs.com/package/@testcontainers/postgresql)
with image `pgvector/pgvector:pg16` — pgvector + pgcrypto extensions
are required for vector + UUID columns.

---

## 2. Run locally (Docker required)

Prereqs:

- Docker daemon reachable (`docker info`)
- Node 22, npm 10+
- ~2 GB free disk for the pgvector image on first pull

```bash
cd /workspaces/mcp-knowledge2

# one-off install (already done if npm i ran)
npm install

# unit only — no Docker
npm run test:unit

# integration — pulls pgvector/pgvector:pg16 on first run (~120 s)
npm run test:integration

# all
npm test
```

If your machine has a non-default Docker socket, set
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` before
running.

### 2.1 Reusing the container

Default behaviour is one container per test file (90 s pull on cold cache,
~10 s reuse). To force-reuse across local runs export
`TESTCONTAINERS_REUSE_ENABLE=true` and tag containers (already enabled
via Testcontainers v10's `.withReuse()` if added per-suite — not on by
default to keep CI deterministic).

### 2.2 Speeding up local cycles

```bash
# leave the container running between runs
TESTCONTAINERS_RYUK_DISABLED=true npm run test:integration

# attach to the running postgres
docker exec -it $(docker ps -q --filter ancestor=pgvector/pgvector:pg16) psql -U postgres knowledge
```

---

## 3. Run with explicit Docker-Compose (alternative to testcontainers)

For long debug sessions, manage Postgres yourself:

```bash
docker run --rm -d --name kc2-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=knowledge \
  -p 5433:5432 \
  pgvector/pgvector:pg16

# wait for healthy
until docker exec kc2-pg pg_isready -U postgres; do sleep 1; done

# run migrations
DATABASE_URL=postgres://postgres:postgres@localhost:5433/knowledge \
  npm run db:migrate
psql postgres://postgres:postgres@localhost:5433/knowledge \
  -f drizzle/migrations/0001_rls.sql

# point the suite at the running container
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/knowledge
npm run test:integration

# tear down
docker rm -f kc2-pg
```

Note: `objects-roundtrip.test.ts` reads `TEST_DATABASE_URL` when set,
otherwise spawns testcontainers itself.

---

## 4. Run in CI (GitHub Actions)

Two viable patterns:

### 4.1 Testcontainers (recommended; matches local dev)

```yaml
jobs:
  test-integration:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - name: Pre-pull pgvector image
        run: docker pull pgvector/pgvector:pg16
      - run: npm run test:integration
        env:
          # Reuse images on warm runners
          TESTCONTAINERS_REUSE_ENABLE: 'true'
```

GH-Actions default runners ship a working Docker socket, so no
additional setup is needed. Expect ~2 min per run after warm cache.

### 4.2 Service-container variant

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    env:
      POSTGRES_DB: knowledge
      POSTGRES_PASSWORD: postgres
    ports: ['5432:5432']
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 5s
      --health-retries 10
steps:
  - run: npm ci
  - run: DATABASE_URL=postgres://postgres:postgres@localhost:5432/knowledge npm run db:migrate
  - run: psql $DATABASE_URL -f drizzle/migrations/0001_rls.sql
  - run: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/knowledge npm run test:integration
```

Faster cold-start (no Testcontainers overhead) but couples the test
runner to a single `TEST_DATABASE_URL`. Pick whichever your team
prefers — both are supported by the test code.

---

## 5. Run against a live deploy (smoke)

The integration tests are **not** safe to run against a real deployment
(they wipe tables in `beforeEach`). For live-deploy smoke use:

```bash
# Hetzner / staging
bash scripts/smoke.sh https://knowledge.staging.example
```

`scripts/smoke.sh` (Layer-2-equivalent) walks the same routes
read-only-ish: creates a fixture object, reads it, deletes it, and
confirms 4xx behaviour on auth-missing requests. It does **not**
exercise the share-with-another-user path (would require two real
identities).

---

## 6. Debugging failures

### 6.1 "container start timeout"

Increase the testcontainers timeout in
`tests/integration/objects-roundtrip.test.ts` `beforeAll(..., 120_000)`
(default 90 s). First-time image pulls on slow networks can take longer.

### 6.2 "extension vector does not exist"

Container started with the wrong image. Re-check the test file uses
`pgvector/pgvector:pg16`, not stock `postgres:16`.

### 6.3 "permission denied for relation objects"

RLS is enabled but `knowledge_app` role lacks GRANTs. Re-run
`drizzle/migrations/0000_init.sql` and `0001_rls.sql` in order — they
set `GRANT SELECT, INSERT, UPDATE, DELETE` on all current tables.

### 6.4 "JWT verification failed"

The roundtrip suite generates its own keypair and exposes a local JWKS
on a random port. If you see this error, the JWKS-mock didn't bind
(`EADDRINUSE`); rerun with a different port range
(`TEST_JWKS_PORT=49152`).

### 6.5 Inspecting state

Tests run in a transaction unless they hit the server. To poke around:

```bash
docker exec -it <container-id> psql -U postgres knowledge
\dt           # list tables
\d objects    # show columns
SELECT id, kind, title, deleted_at FROM objects;
```

---

## 7. Outstanding work

- `tests/e2e/` is empty. Once mcp-approval2 cuts over, add a
  black-box test there that hits a deployed staging URL with a real
  JWT.
- `npm run smoke` (`scripts/smoke.sh`) is stubbed — flesh out once
  staging deploy lands.

See [docs/CROSS-SERVICE-CONTRACT.md §6](../CROSS-SERVICE-CONTRACT.md#6-resolution-strategy)
for the cross-service rollout sequencing.
