-- 0023_group_members_see_each_other.sql
--
-- P2-2: Phase 1 limitierte die group_members_visibility-Policy auf
--   "user_id = self OR owns_group(group_id, self)" — damit sah ein Member
--   nur die EIGENE Zeile + Owner sah alle. Phase 2-2 erweitert das auf:
--   "self OR owns_group(...) OR is_active_member_of(group_id, self)"
--
-- Damit kann jeder aktive Member alle anderen aktiven Member desselben
-- Group sehen. UX-Hintergrund: PWA Group-Detail-View braucht die volle
-- Member-Liste, ansonsten muesste jeder Member den Owner fragen wer noch
-- in der Group ist — schlechte Trust-Latency.
--
-- Recursion-safe: `is_active_member_of` ist SECURITY DEFINER (Mig 0022),
-- bypasst die Policy-Auswertung im Function-Body. Kein cross-table
-- Trigger-Cycle mit groups.policy.
--
-- "removed_at IS NULL"-Filter ist im Helper drin → wer raus ist sieht
-- die anderen sofort nicht mehr (auf seiner Session, nach naechstem
-- Read-Refresh).
--
-- Konsequenz: aktive Member sehen auch removed_at!=NULL Rows derselben
-- Group (Policy ist row-level, das Helper-Predicate haengt nicht von
-- row.user_id ab). Das ist akzeptiert — Caller-Layer (Service/PWA)
-- filtert `WHERE removed_at IS NULL` zusätzlich wenn nur aktive Member
-- in der UI angezeigt werden sollen. RLS dient hier als Outer-Bound,
-- nicht als Inner-Filter.

DROP POLICY IF EXISTS group_members_visibility ON group_members;
CREATE POLICY group_members_visibility ON group_members FOR SELECT
  USING (
    user_id = current_setting('app.current_user', true)::uuid
    OR owns_group(group_id, current_setting('app.current_user', true)::uuid)
    OR is_active_member_of(group_id, current_setting('app.current_user', true)::uuid)
  );

-- group_members_owner_modify bleibt unveraendert (nur Owner kann INSERT/
-- UPDATE/DELETE, das ist Pflicht — Members duerfen sich nicht selbst
-- hinzufuegen/entfernen).
