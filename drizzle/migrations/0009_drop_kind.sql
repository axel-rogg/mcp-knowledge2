-- 0009_drop_kind.sql — Remove kind discriminator, generic object model
-- See ADR-0004 + GENERIC-DATA-MODEL.md v3
-- Pre-pilot greenfield: no data to migrate.
-- Slot 0009 (not 0005) — AS-3 has consumed 0005-0008 for signing_keys, users_and_invites,
--   audit_proxy_columns, oauth_facade_state.

-- objects: drop kind column + dependent indexes + CHECK
ALTER TABLE objects DROP CONSTRAINT IF EXISTS objects_kind_check;
DROP INDEX IF EXISTS idx_objects_owner_kind;
DROP INDEX IF EXISTS idx_objects_owner_hash;
ALTER TABLE objects DROP COLUMN kind;

-- Recreate indexes without kind
CREATE INDEX idx_objects_owner_subtype ON objects (owner_id, subtype) WHERE deleted_at IS NULL;
CREATE INDEX idx_objects_owner_hash    ON objects (owner_id, body_hash) WHERE body_hash IS NOT NULL;

-- share_grants: drop resource_kind column + CHECK
ALTER TABLE share_grants DROP CONSTRAINT IF EXISTS share_grants_resource_kind_check;
ALTER TABLE share_grants DROP COLUMN resource_kind;

-- audit_log: drop resource_kind column (replaces v2-plan "keep as nullable TEXT" decision —
--   §6.4 strategy-entscheid favorisiert drop weil audit-info kann in details_json wandern).
-- Falls §6.4 anders entschieden wird (keep): diesen Block aus 0009 streichen.
ALTER TABLE audit_log DROP COLUMN IF EXISTS resource_kind;
