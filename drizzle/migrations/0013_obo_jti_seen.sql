-- 0013_obo_jti_seen.sql
--
-- SEC-K-010 (HIGH): OBO-Token hatte keine jti-Replay-Protection im 120s-
-- Expiry-Window. TLS-MITM, Log-Leak, Proxy-Cache liessen Replay zu.
-- approval_id war partial mitigation fuer writes, aber nicht single-use
-- enforced.
--
-- Fix: pro OBO-Call ein jti (von approval2's signOBO als randomUuid gesetzt)
-- in seen-table tracken. INSERT auf PK-Conflict = Replay → 401.
-- TTL via exp_at (Token-exp + 60s sweep grace). Sweep-Cron raeumt alte Rows.

CREATE TABLE obo_jti_seen (
  jti TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  seen_at BIGINT NOT NULL,
  exp_at BIGINT NOT NULL
);

CREATE INDEX obo_jti_seen_exp_idx ON obo_jti_seen (exp_at);
