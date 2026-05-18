-- 0024_group_write_scope.sql
--
-- P2-3: Group-Sharing mit scope='write' aktivieren.
--
-- Phase 1 (Mig 0019) erlaubte share_grants.scope='write' nur fuer User-Grants
-- (owner_or_writer_modify-Policy hat nur granted_to=current_user-Pfad). Group-
-- Writes wurden im App-Code als 501 abgewiesen.
--
-- Phase 2-3: zweiter Pfad in der UPDATE-Policy fuer group-grants mit
-- scope='write'. Members einer Group koennen jetzt ein Object updaten wenn:
--   - es einen aktiven group-grant (granted_to_group_id=group, scope='write')
--   - sie aktive Member dieser Group sind (is_active_member_of)
--   - grant nicht expired/revoked
--
-- Recursion-safe: is_active_member_of ist SECURITY DEFINER (Mig 0022).

DROP POLICY IF EXISTS owner_or_writer_modify ON objects;
CREATE POLICY owner_or_writer_modify ON objects FOR UPDATE
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    -- User-Grant mit scope='write'
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
    -- Group-Grant mit scope='write' und current_user ist aktives Member
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
    owner_id = current_setting('app.current_user', true)::uuid
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

-- Hinweis: ein scope='write' Group-Grant impliziert Read-Access — der
-- owner_or_shared_read-Policy-Pfad (Mig 0019 / 0022) checked nur dass
-- ein aktiver Group-Grant existiert, scope-unabhaengig. Daher kein
-- separater Read-Pfad fuer write-Grants noetig.
