-- AS-3 K2: User registry + invites.
--
-- Spec: docs/plans/active/PLAN-as3-autonomous.md §1.2.
--
-- Tables:
--   * users   — internal user registry, auto-provisioned from Google ID-token
--   * invites — admin-issued invite tokens (First-Login-First-Admin bootstrap)
--
-- Both admin-owned (no RLS) because the auth-layer reads them BEFORE any
-- user-context is established. Strict GRANTs limit app role to the exact
-- mutations needed during login.

CREATE EXTENSION IF NOT EXISTS citext;

-- ─── users ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  google_sub    TEXT UNIQUE,                    -- NULL until first Google login
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member'
                  CHECK (role IN ('admin','member')),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','erased')),
  created_at    BIGINT NOT NULL,
  last_seen_at  BIGINT,
  invited_by    UUID REFERENCES users(id),
  invite_token  TEXT UNIQUE                      -- NULL once accepted
);
CREATE INDEX IF NOT EXISTS idx_users_status     ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;

-- ─── invites ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       CITEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL,
  invited_by  UUID NOT NULL REFERENCES users(id),
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_email   ON invites (email)      WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites (expires_at) WHERE used_at IS NULL;

-- ─── GRANTs ───────────────────────────────────────────────────────────────
-- App role:
--   users    — SELECT (jwt-verify-side lookup), INSERT/UPDATE (auto-provision)
--   invites  — SELECT (lookup by token), UPDATE (mark used_at)
-- Admin role:
--   full DML for invite-creation, role-elevation, erasure
REVOKE ALL ON users   FROM knowledge_app;
REVOKE ALL ON invites FROM knowledge_app;

GRANT SELECT, INSERT, UPDATE ON users   TO knowledge_app;
GRANT SELECT,         UPDATE ON invites TO knowledge_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON users   TO knowledge_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON invites TO knowledge_admin;
