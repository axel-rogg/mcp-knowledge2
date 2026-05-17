-- AS-3 K3/K4: OAuth-facade persistent state.
--
-- Tables:
--   * oauth_clients      — DCR-registered MCP clients
--   * oauth_auth_codes   — short-lived authorization codes (10 min TTL)
--   * oauth_refresh_tokens — refresh tokens (single-use, 14d inactivity)
--
-- All admin-owned. The OAuth-facade handlers run under the admin pool
-- because they execute pre-RLS-context (no users.id yet for /authorize).

-- ─── oauth_clients ────────────────────────────────────────────────────────
-- DCR-registered MCP clients (Claude.ai, etc.). 90d inactivity-lifetime
-- per K-D5; cleanup-cron is a follow-up.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_secret  TEXT,                                    -- NULL for public clients (PKCE-only)
  client_name    TEXT,
  redirect_uris  TEXT[] NOT NULL,
  grant_types    TEXT[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token'],
  response_types TEXT[] NOT NULL DEFAULT ARRAY['code'],
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none', -- 'none' | 'client_secret_post' | 'client_secret_basic'
  scope          TEXT NOT NULL DEFAULT 'objects:read objects:write search shares',
  created_at     BIGINT NOT NULL,
  last_used_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_last_used ON oauth_clients (last_used_at);

-- ─── oauth_auth_codes ─────────────────────────────────────────────────────
-- Short-lived authorization code records used by /oauth/authorize + /oauth/token.
-- Code is hashed (sha256) so a DB-leak doesn't disclose unused codes.
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash         TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id           UUID NOT NULL,
  redirect_uri      TEXT NOT NULL,
  scope             TEXT,
  code_challenge    TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,                     -- 'S256' only
  google_id_token_sub TEXT NOT NULL,                       -- captured at authorize-time for idp_sub claim
  created_at        BIGINT NOT NULL,
  expires_at        BIGINT NOT NULL,
  consumed_at       BIGINT
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_auth_codes (expires_at);

-- ─── oauth_refresh_tokens ─────────────────────────────────────────────────
-- Single-use refresh tokens (K-D2). Stored as sha256 hash. `rotated_to`
-- tracks the replacement when a refresh swap happens.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash        TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id           UUID NOT NULL,
  scope             TEXT,
  google_id_token_sub TEXT NOT NULL,
  created_at        BIGINT NOT NULL,
  last_used_at      BIGINT,
  expires_at        BIGINT NOT NULL,                       -- 14d inactivity
  rotated_to        TEXT,                                  -- next token hash if rotated
  revoked_at        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens (expires_at) WHERE revoked_at IS NULL;

-- ─── GRANTs ───────────────────────────────────────────────────────────────
-- These tables are admin-only: facade handlers explicitly use withAdminTx().
-- App role gets no access — there's no per-user RLS angle here.
REVOKE ALL ON oauth_clients        FROM knowledge_app;
REVOKE ALL ON oauth_auth_codes     FROM knowledge_app;
REVOKE ALL ON oauth_refresh_tokens FROM knowledge_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_clients        TO knowledge_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_auth_codes     TO knowledge_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_refresh_tokens TO knowledge_admin;
