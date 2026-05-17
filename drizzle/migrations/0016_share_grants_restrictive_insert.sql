-- 0016_share_grants_restrictive_insert.sql
--
-- SEC-K-NEW (CRITICAL): grants_self (FOR ALL) und grants_insert_by_owner
-- (FOR INSERT) sind beide PERMISSIVE. PostgreSQL OR'd PERMISSIVE-Policies,
-- d.h. ein INSERT passiert wenn ENTWEDER:
--   - grants_self.WITH CHECK = true (granted_to=current OR granted_by=current)
--   - ODER grants_insert_by_owner.WITH CHECK = true (granted_by=current AND
--                                                   objects.owner=current)
--
-- Damit kann ein User B mit `granted_by=B, granted_to=B, resource_id=<A's
-- doc>` einen forged share_grant inserten — grants_self.WITH CHECK ist true
-- weil granted_by=current, die Ownership-Klausel in grants_insert_by_owner
-- wird durch OR umgangen. Anschliessend macht objects.owner_or_shared_read
-- A's doc fuer B sichtbar (es lookupt share_grants nach granted_to=B).
--
-- Heute mitigiert durch app-layer ownership-check in src/storage/shares.ts
-- `createShare()`. RLS ist jedoch die letzte Verteidigungslinie — gefunden
-- via neue rls.test.ts (commit f23bd5a).
--
-- Fix: grants_insert_by_owner als RESTRICTIVE. RESTRICTIVE-Policies werden
-- AND'd mit PERMISSIVE — beide muessen passen → forged INSERT blocked.

DROP POLICY IF EXISTS grants_insert_by_owner ON share_grants;
CREATE POLICY grants_insert_owner_required ON share_grants
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    granted_by = current_setting('app.current_user', true)::uuid
    AND EXISTS (
      SELECT 1 FROM objects
      WHERE objects.id = share_grants.resource_id
        AND objects.owner_id = current_setting('app.current_user', true)::uuid
    )
  );
