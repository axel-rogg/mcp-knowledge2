-- 0015_users_dek_salt.sql
--
-- SEC-K-005 (CRITICAL): Per-User HKDF-Salt damit Master-Key-Leak nicht
-- automatisch alle DEKs ableitbar macht. Heute war salt = plain userId
-- (öffentlich sichtbar in audit_log, share_grants, etc), also brauchte
-- ein Angreifer nur den Master + öffentliche User-IDs um beliebige DEKs
-- zu derivieren.
--
-- Fix: 32 zufällige Bytes pro User in users.dek_salt, gemischt in den
-- HKDF-Input. Master-Leak alleine reicht dann nicht mehr — der dek_salt
-- müsste auch aus der DB extrahiert werden.
--
-- STEP A (diese Migration):
-- Spalte hinzufügen mit DEFAULT gen_random_bytes(32). Existierende User
-- bekommen automatisch einen zufälligen Salt. Code in hkdf_local.ts +
-- cloud_kms.ts ignoriert die Spalte noch — kein Decrypt-Bruch.
--
-- STEP B (separater Commit nach dieser Migration):
-- HKDF-Code in beiden Adaptern updated, ctx.userDekSalt-Wiring,
-- Re-Encrypt-Script läuft lokal vor B-Deploy.
--
-- dek_salt_version: zukünftiges Feld für DEK-Rotation (info='dek-v2'
-- ohne Schema-Change). Default 1.

ALTER TABLE users
  ADD COLUMN dek_salt BYTEA NOT NULL DEFAULT gen_random_bytes(32)
    CHECK (octet_length(dek_salt) = 32),
  ADD COLUMN dek_salt_version INTEGER NOT NULL DEFAULT 1;
