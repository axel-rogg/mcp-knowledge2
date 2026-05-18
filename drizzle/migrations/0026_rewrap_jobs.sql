-- 0026_rewrap_jobs.sql
--
-- P2-7: Async Re-Wrap-Worker fuer groups mit >1000 share_grants.
--
-- Phase 1 (Mig 0019) hat removeMember bei grant_count > 1000 mit 503
-- abgewiesen (sync-rotation in einer TX wuerde zu lange das groups.id-Lock
-- halten). P2-7 ersetzt das durch enqueue-into-rewrap_jobs:
--
--   1. removeMember TX-1: rotate group.master_version, re-wrap remaining
--      group_members (kleine Menge), mark removed_member, INSERT rewrap_jobs
--   2. Async-Worker picked pending Jobs, re-wraps share_grants in Batches
--      von 100, committed per Batch
--
-- Sicherheit zwischen TX-1 und Worker-Completion: share_grants haben
-- group_master_version = OLD. Der removed member kann theoretisch noch
-- die alten wraps decrypten (er hatte das alte Master in Memory). Wir
-- akzeptieren das Risiko — KMS-side wird der OLD-Master beim Rotate NICHT
-- zerstoert (nur ueberschrieben), aber er ist nach der Rotation nur noch
-- im Process-Cache aktiv. Cache-TTL ist 5min (Mig 0022-Aera Helper). Nach
-- Cache-Expiry ist OLD-Master nicht mehr verfuegbar.
--
-- Worst-Case-Window: 5min nach Member-Remove. Acceptable bei Crypto-Review
-- §3.4 "removed member sieht bereits gelesene Inhalte bleibt".

CREATE TABLE IF NOT EXISTS rewrap_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  old_master_version  INTEGER NOT NULL,
  new_master_version  INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_grants        INTEGER NOT NULL,
  processed_grants    INTEGER NOT NULL DEFAULT 0,
  batch_size          INTEGER NOT NULL DEFAULT 100,
  triggered_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  trigger_reason      TEXT NOT NULL,
  created_at          BIGINT NOT NULL,
  started_at          BIGINT,
  completed_at        BIGINT,
  last_error          TEXT,
  -- Encrypted snapshot of OLD-Master fuer den Worker (KMS-wrapped).
  -- Wird nach completed_at gelöscht (NULL gesetzt) damit kein dangling
  -- Old-Master in der DB liegt. Worker entpackt via KMS, re-wraps grants,
  -- wirft Plaintext weg.
  old_master_kms_wrapped BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rewrap_jobs_status_pending
  ON rewrap_jobs (created_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_rewrap_jobs_group
  ON rewrap_jobs (group_id, status);

-- RLS: rewrap_jobs sind Operator-/System-Daten — nur knowledge_admin
-- (BYPASSRLS) sieht sie. RLS-Policy gibt es nicht; knowledge_app hat
-- keine Rechte auf der Tabelle (keine GRANT).
GRANT SELECT, INSERT, UPDATE ON rewrap_jobs TO knowledge_admin;
