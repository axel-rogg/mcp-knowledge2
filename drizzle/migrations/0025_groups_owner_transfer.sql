-- 0025_groups_owner_transfer.sql
--
-- P2-4: Group-Owner-Transfer.
--
-- Phase 1 (Mig 0019) hat groups_owner_modify als FOR ALL mit
--   USING (owner_id = current_user) WITH CHECK (owner_id = current_user)
-- aufgesetzt. Das blockiert jeden UPDATE der owner_id selbst aendert
-- — auch wenn der aktuelle Owner den Transfer initiiert.
--
-- P2-4 spaltet die Policy:
--   - groups_owner_select_modify (FOR SELECT/DELETE/INSERT): bleibt
--     owner-only, USING+CHECK auf owner_id=current_user
--   - groups_owner_update (FOR UPDATE): USING owner-only, WITH CHECK
--     erlaubt new owner_id wenn der entweder gleich current_user ist
--     (Standard-Update auf andere Felder) ODER er ein aktives Member
--     ist (Owner-Transfer-Pfad)
--
-- Recursion-safe: nutzt is_active_member_of (SECURITY DEFINER aus Mig 0022).

DROP POLICY IF EXISTS groups_owner_modify ON groups;

-- INSERT / DELETE: nur Owner darf (existing behavior)
CREATE POLICY groups_owner_insert ON groups FOR INSERT
  WITH CHECK (owner_id = current_setting('app.current_user', true)::uuid);

CREATE POLICY groups_owner_delete ON groups FOR DELETE
  USING (owner_id = current_setting('app.current_user', true)::uuid);

-- UPDATE: USING owner-only, WITH CHECK erlaubt Transfer
CREATE POLICY groups_owner_update ON groups FOR UPDATE
  USING (owner_id = current_setting('app.current_user', true)::uuid)
  WITH CHECK (
    -- Standard-Update auf andere Felder: owner_id bleibt unveraendert
    owner_id = current_setting('app.current_user', true)::uuid
    OR
    -- Transfer: neuer owner_id ist aktives Member dieser Group
    is_active_member_of(id, owner_id)
  );

-- Hinweis: das CHECK-Predicate matcht zwei Faelle:
--   a) Standard-Update: USING + WITH CHECK beide auf "current = owner".
--      Aktueller Owner kann name/description/cascade_on_share_default
--      etc. modifizieren weil owner_id unveraendert bleibt.
--   b) Transfer: USING matcht "current = OLD.owner_id" (Berechtigungs-
--      Pruefung). WITH CHECK matcht "NEW.owner_id ist aktives Member"
--      via is_active_member_of(group.id, NEW.owner_id). Damit kann der
--      Owner den owner_id auf einen Member-User updaten — aber nicht
--      auf einen Non-Member.
