-- 0028_rls_group_ownership.sql
--
-- Phase 3b: RLS-Policies fuer group-owned Objects.
-- Plan-Ref: PLAN-generic-objects-and-group-ownership.md §A4
--
-- Erweitert alle 4 RLS-Policies (SELECT/UPDATE/DELETE/INSERT) auf objects
-- um den group-mode-Pfad: aktives Member der owning_group hat denselben
-- Zugriff wie ein owner.
--
-- User-Decisions:
--   #1 jeder aktive Member kann group-owned-Objects updaten
--   #2 jeder aktive Member kann group-owned-Objects deleten
--
-- Recursion-Safety: nutzt `is_active_member_of` SECURITY DEFINER aus
-- Mig 0022 — kein cross-table Policy-Trigger-Loop.

-- ── SELECT: owner OR active-group-member OR user-grant OR group-grant ─────

DROP POLICY IF EXISTS owner_or_shared_read ON objects;
CREATE POLICY owner_or_shared_read ON objects FOR SELECT
  USING (
    -- user-owned: owner reads
    owner_id = current_setting('app.current_user', true)::uuid
    -- group-owned: active member reads (NEU Phase 3b)
    OR (owning_group_id IS NOT NULL
        AND is_active_member_of(owning_group_id, current_setting('app.current_user', true)::uuid))
    -- direct user-grant (Mig 0019 unverändert)
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
    -- group-grant (Mig 0019/0022 unverändert)
    OR EXISTS (
      SELECT 1 FROM share_grants sg
      WHERE sg.resource_id = objects.id
        AND sg.granted_to_group_id IS NOT NULL
        AND sg.revoked_at IS NULL
        AND (sg.expires_at IS NULL OR sg.expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
        AND is_active_member_of(sg.granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
  );

-- ── UPDATE: owner OR active-group-member OR scope=write-grants ───────────

DROP POLICY IF EXISTS owner_or_writer_modify ON objects;
CREATE POLICY owner_or_writer_modify ON objects FOR UPDATE
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    -- group-owned: active member darf updaten (User-Decision #1)
    OR (owning_group_id IS NOT NULL
        AND is_active_member_of(owning_group_id, current_setting('app.current_user', true)::uuid))
    -- User-Grant scope='write' (Mig 0024 unverändert)
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
    -- Group-Grant scope='write' (Mig 0024 unverändert)
    OR EXISTS (
      SELECT 1 FROM share_grants sg
      WHERE sg.resource_id = objects.id
        AND sg.granted_to_group_id IS NOT NULL
        AND sg.revoked_at IS NULL
        AND sg.scope = 'write'
        AND (sg.expires_at IS NULL OR sg.expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
        AND is_active_member_of(sg.granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
  )
  WITH CHECK (
    -- WITH CHECK = same logic. Verhindert dass Update den XOR-Constraint
    -- bricht (z.B. owner_id auf NULL setzen ohne owning_group_id zu setzen).
    -- Schema-CHECK fängt das auch ab, aber Defense-in-Depth.
    owner_id = current_setting('app.current_user', true)::uuid
    OR (owning_group_id IS NOT NULL
        AND is_active_member_of(owning_group_id, current_setting('app.current_user', true)::uuid))
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
    OR EXISTS (
      SELECT 1 FROM share_grants sg
      WHERE sg.resource_id = objects.id
        AND sg.granted_to_group_id IS NOT NULL
        AND sg.revoked_at IS NULL
        AND sg.scope = 'write'
        AND (sg.expires_at IS NULL OR sg.expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
        AND is_active_member_of(sg.granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
  );

-- ── DELETE: owner OR active-group-member (User-Decision #2) ──────────────
--
-- Phase 1/2 hatte keinen expliziten DELETE-Policy — objects-Tabelle nutzte
-- den default-FOR-ALL aus Mig 0019. Mit Mig 0028 splitten wir DELETE
-- explizit damit group-owned-delete fuer aktive Member klar erlaubt ist
-- ohne den `owner_or_writer_modify` UPDATE-Policy zu involvieren.

DROP POLICY IF EXISTS owner_or_member_delete ON objects;
CREATE POLICY owner_or_member_delete ON objects FOR DELETE
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR (owning_group_id IS NOT NULL
        AND is_active_member_of(owning_group_id, current_setting('app.current_user', true)::uuid))
  );

-- ── INSERT: owner-of-self OR active-group-member-for-target ──────────────
--
-- Phase 1/2 hatte INSERT-Policy implicit. Mit Phase 3b muss INSERT
-- expliziter werden weil ein active member kann INSERT objects mit
-- owning_group_id=his-group machen.

DROP POLICY IF EXISTS owner_or_group_member_insert ON objects;
CREATE POLICY owner_or_group_member_insert ON objects FOR INSERT
  WITH CHECK (
    -- user-owned: caller MUSS sich selbst als owner setzen
    (owner_id = current_setting('app.current_user', true)::uuid
     AND owning_group_id IS NULL)
    OR
    -- group-owned: caller muss aktives Member sein, owner_id MUSS NULL
    (owner_id IS NULL
     AND owning_group_id IS NOT NULL
     AND is_active_member_of(owning_group_id, current_setting('app.current_user', true)::uuid))
  );
