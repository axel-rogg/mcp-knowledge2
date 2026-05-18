-- 0021_rls_recursion_fix.sql
--
-- CI-Bug-Fix nach 0019/0020 Deploy: Postgres detected infinite recursion
-- in RLS-Policies fuer group_members + groups + objects-via-shared-Pfad.
--
-- Problem:
--   * groups.groups_owner_or_member USING-clause referenziert
--     group_members.group_id (SELECT group_id FROM group_members WHERE ...)
--   * group_members.group_members_visibility USING-clause referenziert
--     group_members SELF (SELECT group_id FROM group_members WHERE
--     user_id=current ...) — RECURSION
--   * Plus: objects.owner_or_shared_read joined share_grants + group_members,
--     triggert die rekursive Policy bei jedem objects-INSERT/SELECT.
--
-- Postgres-Engine detected die Recursion + abort die Query mit
-- "infinite recursion detected in policy".
--
-- Fix-Strategy (Phase-1-pragmatisch):
--   group_members.group_members_visibility wird vereinfacht zu
--   "user_id=current_user OR group_id IN (SELECT id FROM groups WHERE
--    owner_id=current_user)". Cross-Member-Visibility (Member sieht andere
--   Members der gleichen Group) ist Phase-2-Feature ueber SECURITY DEFINER-
--   Helper-Function.
--
--   groups.groups_owner_or_member referenziert weiterhin group_members,
--   aber group_members-Policy referenziert nur noch groups (kein self-Join)
--   → keine Recursion. Postgres macht max-2-Level-Lookup ohne Schleife.
--
-- App-Layer-Auswirkung:
--   * PWA-Group-Detail-View kann nicht via direct-SELECT group_members
--     alle Members sehen. Workaround: Backend-Helper getGroup() laeuft als
--     Group-Owner (Service-Token mit BYPASSRLS) oder verlaesst sich auf
--     groups.owner_or_member-Visibility + separate per-User-Membership-
--     Lookup.
--   * Heute ist PWA `/v1/groups/:id` ein KC2-API-Call der innerhalb
--     withUserTx (RLS-bound) laeuft. Bei `getGroup(groupId)` wird der
--     User entweder Owner sein (sieht alle) oder Member (sieht nur eigene
--     Membership-Row). Phase 2 ergaenzt SECURITY DEFINER fuer das
--     Member-Sees-Others-Pattern.

-- ── group_members: vereinfachte Policy ohne self-recursion ─────────────────

DROP POLICY IF EXISTS group_members_visibility ON group_members;
CREATE POLICY group_members_visibility ON group_members FOR SELECT
  USING (
    -- Aktiver Member sieht seine eigene Row (egal welche Group)
    user_id = current_setting('app.current_user', true)::uuid
    OR
    -- Group-Owner sieht alle Members seiner Groups (auch removed_at IS NOT NULL
    -- bleibt sichtbar fuer Audit-UX)
    group_id IN (
      SELECT id FROM groups
      WHERE owner_id = current_setting('app.current_user', true)::uuid
    )
  );

-- group_members.modify: bleibt Owner-only (war schon nicht-rekursiv,
-- keine Aenderung noetig).
