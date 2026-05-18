-- 0027_object_owning_group.sql
--
-- Phase 3b: Group-Ownership (Hybrid-Modell).
-- Plan-Ref: mcp-approval2/docs/plans/active/PLAN-generic-objects-and-group-ownership.md
-- Crypto-Review: mcp-approval2/docs/security/CRYPTO-REVIEW-GROUP-OWNERSHIP-2026-05-18.md
--
-- Objects können jetzt entweder user-owned ODER group-owned sein (XOR).
-- Industry-Standard wie Google Drive Shared Drives, GitHub Org Repos.
--
-- Migration-Safety: alle existing rows haben owner_id NOT NULL — entspricht
-- XOR-Variante 1 (user-owned). Kein Daten-Move noetig.

-- ── owning_group_id Spalte ────────────────────────────────────────────────

ALTER TABLE objects ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS owning_group_id UUID;

-- XOR-CHECK: genau eines von owner_id oder owning_group_id ist gesetzt
ALTER TABLE objects ADD CONSTRAINT objects_owner_xor
  CHECK (
    (owner_id IS NOT NULL AND owning_group_id IS NULL)
    OR
    (owner_id IS NULL AND owning_group_id IS NOT NULL)
  );

-- FK auf groups via DO-Block (Neon-Pattern aus Phase 2 — non-owner braucht
-- GRANT REFERENCES, das ist nicht gesetzt für knowledge_app auf groups)
DO $$ BEGIN
  ALTER TABLE objects
    ADD CONSTRAINT fk_objects_owning_group
    FOREIGN KEY (owning_group_id) REFERENCES groups(id) ON DELETE RESTRICT;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'fk_objects_owning_group skipped: no REFERENCES on groups (operator-bootstrap may add)';
  WHEN duplicate_object THEN
    RAISE NOTICE 'fk_objects_owning_group already exists';
END $$;

-- Partial Index für Performance der group-owned-Object-Listing
CREATE INDEX IF NOT EXISTS idx_objects_owning_group
  ON objects (owning_group_id, updated_at DESC)
  WHERE owning_group_id IS NOT NULL;

-- ── dek_scheme erweitert um 'group_owned' ─────────────────────────────────

ALTER TABLE objects DROP CONSTRAINT IF EXISTS chk_objects_dek_scheme;
ALTER TABLE objects ADD CONSTRAINT chk_objects_dek_scheme
  CHECK (dek_scheme IN ('owner_hkdf', 'per_object', 'group_owned'));

-- ── group_master_version (Crypto-Review T3) ───────────────────────────────
--
-- Tracking welcher Group-Master-Version das owner_wrapped_dek von einem
-- group-owned Object entspricht. Bei Master-Rotation (Member-Remove)
-- muessen alle objects mit owning_group_id=$G + dek_scheme='group_owned'
-- re-wrappt werden — analog share_grants.group_master_version aus Mig 0019.
-- Worker-Idempotenz: nur Objects mit group_master_version < new_version
-- re-wrappen.

ALTER TABLE objects ADD COLUMN IF NOT EXISTS group_master_version INTEGER;

-- ── object_revisions: dek_scheme erweitert ────────────────────────────────
-- Object-Revisions (historische bodies) behalten dek_scheme der ursprünglichen
-- Version. Bei Move zu group-owned bleiben alte Revs mit dem alten Schema —
-- d.h. owner_hkdf-Revs nach Move sind nur lesbar solange owner-row existiert.
-- Akzeptiert wie in PLAN-Review-T7.

ALTER TABLE object_revisions DROP CONSTRAINT IF EXISTS chk_object_revisions_dek_scheme;
ALTER TABLE object_revisions ADD CONSTRAINT chk_object_revisions_dek_scheme
  CHECK (dek_scheme IN ('owner_hkdf', 'per_object', 'group_owned'));

-- ── is_orphan_object Helper-Function ──────────────────────────────────────
--
-- Phase 3b §A8c: Admin-Sicht für verwaiste Objects.
-- Definition: object.owner_id zeigt auf user mit status IN ('erased',
-- 'suspended'). group-owned objects können NICHT verwaisen (Group-Owner-
-- Transfer ist eigene Operation).
--
-- SECURITY DEFINER damit knowledge_app die Function aufrufen kann ohne
-- direkte SELECT-Permission auf users.

CREATE OR REPLACE FUNCTION is_orphan_object(o UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM objects obj
    JOIN users u ON u.id = obj.owner_id
    WHERE obj.id = o
      AND obj.owner_id IS NOT NULL
      AND u.status IN ('erased', 'suspended')
  );
$$;

GRANT EXECUTE ON FUNCTION is_orphan_object(UUID) TO knowledge_app, knowledge_admin;

-- ── Hinweis fuer naechste Mig 0028 ────────────────────────────────────────
-- RLS-Policies (SELECT/UPDATE/DELETE/INSERT) muessen um owning_group_id-
-- Pfad erweitert werden. Das passiert in 0028 als separate Mig damit
-- Schema-Changes klar von Policy-Changes getrennt sind.
