-- 0019_groups_and_sharing_phase1.sql
--
-- Group-basiertes Document-Sharing Phase 1 — Schema-Migration (additiv).
--
-- Plan-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md
-- Cross-Repo-ADR: mcp-approval2/docs/adr/0024-group-sharing-architecture.md
-- Pre-Build-Crypto-Review: docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md
--
-- Was diese Migration tut:
--   1. ALTER objects: dek_scheme + owner_wrapped_dek + owner_wrap_key_version
--      + cascade_on_share (für Per-Object-DEK + Owner-Self-Read + Cascade-Opt-out)
--   2. CREATE groups + group_members (neue Tabellen)
--   3. ALTER share_grants: granted_to_group_id + via_cascade_from_object_id
--      + wrapped_object_dek + group_master_version
--   4. RLS-Update: objects.owner_or_shared_read + ...modify erweitert auf
--      Group-Membership-Pfad
--   5. RLS für neue Tabellen groups + group_members
--   6. Restrictive INSERT-Policy für group-targeted share_grants
--
-- Was diese Migration NICHT tut (= Phase 1 Code-Schritte später):
--   - Body-Re-Encryption (legacy owner_hkdf-Objects bleiben unverändert
--     bis zum ersten Share — Lazy-Migration im Code)
--   - Daten-Backfill (alle existing Objects bleiben dek_scheme='owner_hkdf')
--   - Group-CRUD-Endpoints
--
-- Roll-back-Safety: alle Statements sind additiv (ADD COLUMN / CREATE TABLE /
-- CREATE POLICY). DROP-Pfad wäre die Inversion in umgekehrter Reihenfolge.
-- Existing share_grants-Rows bleiben gültig — `granted_to` bleibt NOT NULL bis
-- es zumindest eine Group-Row gibt; die XOR-Constraint hat einen GUARD der das
-- auflöst.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. objects: Per-Object-DEK + Owner-Self-Read-Pfad + Cascade-Opt-out
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS dek_scheme TEXT NOT NULL DEFAULT 'owner_hkdf',
  ADD COLUMN IF NOT EXISTS owner_wrapped_dek BYTEA,
  ADD COLUMN IF NOT EXISTS owner_wrap_key_version INTEGER,
  ADD COLUMN IF NOT EXISTS cascade_on_share BOOLEAN NOT NULL DEFAULT TRUE;

-- Consistency: dek_scheme='owner_hkdf' → owner_wrapped_dek NULL,
-- dek_scheme='per_object' → owner_wrapped_dek NOT NULL.
ALTER TABLE objects
  ADD CONSTRAINT chk_objects_dek_scheme_values
  CHECK (dek_scheme IN ('owner_hkdf', 'per_object'));

ALTER TABLE objects
  ADD CONSTRAINT chk_objects_dek_scheme_consistency
  CHECK (
    (dek_scheme = 'owner_hkdf' AND owner_wrapped_dek IS NULL)
    OR
    (dek_scheme = 'per_object' AND owner_wrapped_dek IS NOT NULL)
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 2. groups + group_members
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Group-Master-DEK wrapped mit GCP-KMS (Variante C aus Crypto-Review).
  -- 32-byte plaintext → kms.wrap() → variable ciphertext (~120 Bytes).
  wrapped_master_dek BYTEA NOT NULL,
  -- Monoton inkrementiert bei Member-Remove-Rotation. Coordinator-Lock-Ziel
  -- (SELECT FOR UPDATE auf groups.id für rotation-atomicity).
  master_version INTEGER NOT NULL DEFAULT 1,
  rotated_at BIGINT,
  -- Wenn TRUE: jeder body-Read von non-Owner schreibt share.read-Audit-Event.
  -- Phase-1-Default: FALSE (kein Surveillance-Default; Group-Admin entscheidet).
  read_audit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Default-Wert für cascade-on-share bei addObjectRef innerhalb dieser Group.
  -- Phase-1-Default: TRUE (auto-cascade ist der erwartete UX-Pfad).
  cascade_on_share_default BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  archived_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_groups_owner
  ON groups(owner_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  -- Group-Master-DEK gewrapped mit Member-KEK (per-User-HKDF).
  wrapped_group_dek BYTEA NOT NULL,
  -- = groups.master_version zum Zeitpunkt des wrap. Wenn < groups.master_version
  -- → Member ist stale (post-rotation), muss re-wrap haben.
  wrapped_for_master_version INTEGER NOT NULL,
  joined_at BIGINT NOT NULL,
  removed_at BIGINT,
  PRIMARY KEY (group_id, user_id)
);

ALTER TABLE group_members
  ADD CONSTRAINT chk_group_members_role
  CHECK (role IN ('admin', 'member'));

CREATE INDEX IF NOT EXISTS idx_group_members_user
  ON group_members(user_id) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_group_members_active
  ON group_members(group_id, user_id) WHERE removed_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. share_grants: Group-Target + Cascade-Spur + wrapped_object_dek
-- ──────────────────────────────────────────────────────────────────────────

-- granted_to wird optional (NULL erlaubt für Group-Grants).
ALTER TABLE share_grants ALTER COLUMN granted_to DROP NOT NULL;

ALTER TABLE share_grants
  ADD COLUMN IF NOT EXISTS granted_to_group_id UUID
    REFERENCES groups(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS via_cascade_from_object_id UUID
    REFERENCES objects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS wrapped_object_dek BYTEA,
  ADD COLUMN IF NOT EXISTS group_master_version INTEGER;

-- XOR: entweder granted_to (legacy 1:1-User-Grant) ODER granted_to_group_id
-- (neuer Group-Grant). Niemals beide gleichzeitig. Niemals beide NULL.
ALTER TABLE share_grants
  ADD CONSTRAINT chk_share_grants_target_xor
  CHECK ((granted_to IS NOT NULL) <> (granted_to_group_id IS NOT NULL));

-- Group-Grants brauchen wrapped_object_dek + group_master_version. User-Grants
-- (legacy) brauchen das nicht (Body-Decrypt heute via Owner-DEK).
ALTER TABLE share_grants
  ADD CONSTRAINT chk_share_grants_group_dek_consistency
  CHECK (
    granted_to_group_id IS NULL
    OR (wrapped_object_dek IS NOT NULL AND group_master_version IS NOT NULL)
  );

-- Diamond-Cascade-Safety: dasselbe (resource, group, cascade_source)-Triple
-- darf nur einmal aktiv existieren. Wenn der gleiche Doc über zwei Skill-
-- Cascade-Quellen reinkommt — sieht ON CONFLICT DO NOTHING im Code.
-- Direkt-Shares (via_cascade_from=NULL) und Cascade-Shares haben separate
-- Identity (NULL-Werte in PostgreSQL-UNIQUE sind distinct = mehrere
-- NULL-Rows erlaubt, das ist hier korrekt — Direkt-Share + Cascade-Share
-- sind zwei legitime Wege).
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_grants_group_cascade_unique
  ON share_grants(resource_id, granted_to_group_id, via_cascade_from_object_id)
  WHERE revoked_at IS NULL AND granted_to_group_id IS NOT NULL;

-- Hot-Lookup-Index: alle aktiven Group-Grants pro Resource. Nutzbar in
-- objects.owner_or_shared_read-RLS-Subquery + im Read-Pfad.
CREATE INDEX IF NOT EXISTS idx_share_grants_group_active
  ON share_grants(granted_to_group_id, resource_id)
  WHERE revoked_at IS NULL AND granted_to_group_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. RLS auf neuen Tabellen
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

-- groups: Owner sieht eigene Groups, Member sieht Groups in denen er aktiv ist
DROP POLICY IF EXISTS groups_owner_or_member ON groups;
CREATE POLICY groups_owner_or_member ON groups FOR SELECT
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT group_id FROM group_members
      WHERE user_id = current_setting('app.current_user', true)::uuid
        AND removed_at IS NULL
    )
  );

-- groups: nur Owner kann INSERT/UPDATE/DELETE
DROP POLICY IF EXISTS groups_owner_modify ON groups;
CREATE POLICY groups_owner_modify ON groups FOR ALL
  USING (owner_id = current_setting('app.current_user', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.current_user', true)::uuid);

-- group_members: Owner der Group + Members der Group sehen alle Members
DROP POLICY IF EXISTS group_members_visibility ON group_members;
CREATE POLICY group_members_visibility ON group_members FOR SELECT
  USING (
    -- Group-Owner sieht alle Members seiner Groups
    group_id IN (
      SELECT id FROM groups
      WHERE owner_id = current_setting('app.current_user', true)::uuid
    )
    OR
    -- Aktiver Member sieht alle Members seiner Groups (inkl. removed,
    -- damit "wer wurde wann entfernt" sichtbar bleibt für Audit-UX)
    group_id IN (
      SELECT group_id FROM group_members gm
      WHERE gm.user_id = current_setting('app.current_user', true)::uuid
        AND gm.removed_at IS NULL
    )
  );

-- group_members: nur Group-Owner kann modifizieren (INSERT/UPDATE/DELETE).
-- Admin-Members können nicht über RLS modifizieren — App-Layer-Logik
-- macht admin-role-Check und nutzt admin-DB-URL für member-add/remove (analog
-- bestehender createShare-Pfad). Phase 2 könnte das als RLS-RESTRICTIVE-Policy
-- machen, aber für Phase 1 reicht der App-Layer-Check.
DROP POLICY IF EXISTS group_members_owner_modify ON group_members;
CREATE POLICY group_members_owner_modify ON group_members FOR ALL
  USING (
    group_id IN (
      SELECT id FROM groups
      WHERE owner_id = current_setting('app.current_user', true)::uuid
    )
  )
  WITH CHECK (
    group_id IN (
      SELECT id FROM groups
      WHERE owner_id = current_setting('app.current_user', true)::uuid
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 5. RLS-Update auf objects: shared via group als zusätzlicher Sichtbarkeits-
--    Pfad (komplementär zu existierendem granted_to=user-Pfad)
-- ──────────────────────────────────────────────────────────────────────────

-- SELECT: owner OR direct-share OR group-share
DROP POLICY IF EXISTS owner_or_shared_read ON objects;
CREATE POLICY owner_or_shared_read ON objects FOR SELECT
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
    OR id IN (
      SELECT sg.resource_id FROM share_grants sg
      INNER JOIN group_members gm ON gm.group_id = sg.granted_to_group_id
      WHERE gm.user_id = current_setting('app.current_user', true)::uuid
        AND gm.removed_at IS NULL
        AND sg.revoked_at IS NULL
        AND (sg.expires_at IS NULL OR sg.expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
  );

-- UPDATE: owner OR direct-share with scope='write' (Group-Write bleibt
-- Phase-1 explicit 501 im App-Code — RLS lässt Group-Write durch nur wenn
-- Phase 2 das einschaltet). Aktuell: kein Group-Write-Pfad in RLS.
DROP POLICY IF EXISTS owner_or_writer_modify ON objects;
CREATE POLICY owner_or_writer_modify ON objects FOR UPDATE
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
  )
  WITH CHECK (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 6. RLS-Update auf share_grants: Group-Owner darf Group-Grants inserten
-- ──────────────────────────────────────────────────────────────────────────

-- Bestehende `grants_self` (FOR ALL, PERMISSIVE) lässt User Grants sehen wenn
-- granted_to=current_user. Wir erweitern auf granted_to_group_id-Mitgliedschaft.
DROP POLICY IF EXISTS grants_self ON share_grants;
CREATE POLICY grants_self ON share_grants
  USING (
    granted_to = current_setting('app.current_user', true)::uuid
    OR granted_by = current_setting('app.current_user', true)::uuid
    OR granted_to_group_id IN (
      SELECT group_id FROM group_members
      WHERE user_id = current_setting('app.current_user', true)::uuid
        AND removed_at IS NULL
    )
    OR granted_to_group_id IN (
      SELECT id FROM groups
      WHERE owner_id = current_setting('app.current_user', true)::uuid
    )
  );

-- Existing restrictive INSERT-Policy aus 0016 deckt nur User-Grants
-- (granted_to + resource-owner-check). Group-Grants brauchen analoge
-- RESTRICTIVE-Policy: granted_by=current_user UND
--   (granted_to_group_id-owner=current_user ODER current_user ist Group-Admin
--    UND resource gehört current_user).
-- Phase 1: nur Group-OWNER darf Group-Grants inserten (admin-Members können
-- später, App-Layer-Logic mit BYPASSRLS-Admin-Pfad bei Bedarf).
DROP POLICY IF EXISTS grants_insert_group_owner_required ON share_grants;
CREATE POLICY grants_insert_group_owner_required ON share_grants
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    -- Wenn legacy User-Grant: bestehender Pfad (granted_by + owner-of-resource)
    (
      granted_to IS NOT NULL
      AND granted_by = current_setting('app.current_user', true)::uuid
      AND EXISTS (
        SELECT 1 FROM objects
        WHERE objects.id = share_grants.resource_id
          AND objects.owner_id = current_setting('app.current_user', true)::uuid
      )
    )
    OR
    -- Wenn Group-Grant: granted_by=current_user UND owner-of-resource
    -- UND owner-of-target-group (= darf in eigene Group sharen)
    (
      granted_to_group_id IS NOT NULL
      AND granted_by = current_setting('app.current_user', true)::uuid
      AND EXISTS (
        SELECT 1 FROM objects
        WHERE objects.id = share_grants.resource_id
          AND objects.owner_id = current_setting('app.current_user', true)::uuid
      )
      AND EXISTS (
        SELECT 1 FROM groups
        WHERE groups.id = share_grants.granted_to_group_id
          AND groups.owner_id = current_setting('app.current_user', true)::uuid
      )
    )
  );
