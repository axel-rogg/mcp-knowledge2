-- 2026-05-16: raise default daily embed-call quota from 1000 → 5000.
--
-- Rationale: pilot-operator confirmed higher tolerance. CF Workers AI bge-m3
-- ~$0.0001/call → 5000 = $0.50/day hard cap. Realistic Solo-Pilot usage is
-- <100 embed-calls/day (object-create + search), so the cap is a guard-rail
-- against bugs, not the expected load.
--
-- The application-level constant in src/quota/check.ts is also bumped to
-- 5000 (DEFAULTS.embed_calls_per_day). Both must stay in sync — kept
-- here as a single source of truth at schema level.

ALTER TABLE user_quotas
  ALTER COLUMN embed_calls_per_day SET DEFAULT 5000;

-- Lift any existing rows that still carry the old default. New rows
-- inserted by ensureQuotaRow() already set 5000 explicitly, but
-- previously-seeded rows would stick at 1000 without this UPDATE.
UPDATE user_quotas
  SET embed_calls_per_day = 5000,
      updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
WHERE embed_calls_per_day = 1000;
