-- 0012_users_external_id.sql
--
-- SEC-K-006 (CRITICAL): users-Sync von approval2 keyed nur auf email,
-- external_id wird nicht persistiert. Damit kann ein SERVICE_TOKEN-Leak
-- (oder approval2-Compromise) eine Mallory-Session in eine existing-admin-
-- Row fusen ("admin@firma.de"-Email-Collision-Take-Over).
--
-- Fix: external_id-Spalte hinzufuegen + UNIQUE-Index. App-Code (api.ts
-- syncFromApproval2) persistiert + verifiziert: bei Email-Match mit
-- mismatched external_id → refuse.
--
-- NULL erlaubt fuer Bootstrap-Admin (kein approval2-Origin) + Migration-
-- Window (alte Rows bekommen external_id later via Re-Sync).

ALTER TABLE users ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX users_external_id_unique_idx ON users (external_id) WHERE external_id IS NOT NULL;
