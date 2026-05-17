-- 0014_vec_owner_only_rls.sql
--
-- SEC-K-023 (HIGH): RLS-Policy `vec_via_object` delegierte sichtbarkeit von
-- object_vectors an die owner-or-shared-Policy von objects. Damit konnte ein
-- Share-Grantee mit scope='read' das embedding-Vektor lesen → Morris-2023
-- Embedding-Inversion kann partial Body-Content rekonstruieren obwohl der
-- Grantee nur zu Title/Description authorisiert war.
--
-- Fix: vec auf Owner-Only einschränken. Multi-User-Shared-Search bleibt
-- möglich, weil das Search-API (src/search/hybrid.ts) als der User-Owner
-- läuft (RLS-bound) und nur ID-Sets liefert. Vec selbst nie über die
-- Service-Boundary lesbar.
--
-- Solo-Pilot heute: keine aktiven Shares → kein UX-Impact. Wird relevant
-- wenn Multi-User-Sharing aktiviert wird, dann braucht ein separater
-- vector-share-scope ein dediziertes Re-Encrypt-vor-Share-Pattern.

DROP POLICY IF EXISTS vec_via_object ON object_vectors;
CREATE POLICY vec_owner_only ON object_vectors
  USING (
    EXISTS (
      SELECT 1 FROM objects
      WHERE objects.id = object_vectors.object_id
        AND objects.owner_id = current_setting('app.current_user', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM objects
      WHERE objects.id = object_vectors.object_id
        AND objects.owner_id = current_setting('app.current_user', true)::uuid
    )
  );
