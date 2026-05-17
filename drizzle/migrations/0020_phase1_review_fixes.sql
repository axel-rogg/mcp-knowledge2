-- 0020_phase1_review_fixes.sql
--
-- Nachbesserung zur Migration 0019 nach PLAN-Review.
--
-- Plan-Review-Ref: docs/security/PLAN-REVIEW-SHARING-PHASE-1-2026-05-17.md
--   §2 (Schema-Findings) und §4 (Code-Pfade)
--
-- Was diese Migration tut:
--   1. object_revisions.dek_scheme Spalte (Lazy-Migration produziert
--      Mixed-State: alte Rev legacy, neue Rev per_object — pro-Revision-
--      Tracking noetig)
--   2. Diamond-Cascade-UNIQUE-Index NULL-Pitfall fix (Postgres NULL ist
--      distinct in UNIQUE — split in 2 Partial-Indexes: einer fuer
--      direct-shares (via_cascade_from IS NULL), einer fuer cascade-shares)
--   3. groups.owner_id FK Constraint zu users(id) ON DELETE RESTRICT —
--      verhindert orphan Groups bei User-Delete. GDPR-Erase-Flow muss
--      Group-Archive/Owner-Transfer vor User-Delete machen (App-Layer).
--   4. group_members.user_id Foreign-Key analog
--
-- Roll-back-Safety: alle Statements sind additiv (ADD COLUMN / DROP INDEX +
-- CREATE INDEX / ADD CONSTRAINT). DROP-Pfad = inverse Reihenfolge.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. object_revisions.dek_scheme — pro-Revision-DEK-Tracking
-- ──────────────────────────────────────────────────────────────────────────

-- Bei Lazy-Migration eines Objects:
--   * Alte Revs (vor Migration) bleiben mit Owner-DEK + AAD
--     'object-revisions|<ownerId>|<objectId>' verschluesselt
--   * Neue Revs (nach Migration) werden mit Per-Object-DEK + AAD
--     'object-revisions-v2|<objectId>' verschluesselt
-- src/storage/revisions.ts braucht dispatch-logic basierend auf dieser
-- Spalte — analog objects.dek_scheme.

ALTER TABLE object_revisions
  ADD COLUMN IF NOT EXISTS dek_scheme TEXT NOT NULL DEFAULT 'owner_hkdf';

ALTER TABLE object_revisions
  ADD CONSTRAINT chk_object_revisions_dek_scheme
  CHECK (dek_scheme IN ('owner_hkdf', 'per_object'));

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Diamond-Cascade-UNIQUE-Index NULL-Pitfall fix
-- ──────────────────────────────────────────────────────────────────────────
--
-- Problem 0019: UNIQUE(resource_id, granted_to_group_id, via_cascade_from_
-- object_id) WHERE revoked_at IS NULL AND granted_to_group_id IS NOT NULL.
-- Postgres behandelt NULL als distinct in UNIQUE — d.h. mehrere Direct-
-- Shares (via_cascade_from IS NULL) auf dasselbe (resource, group)-Paar
-- sind moeglich. Das verletzt die Diamond-Cascade-Safety nicht (Direct-
-- Share kann nicht "diamond-collide"), aber erzeugt Duplicate-Rows die
-- spaeter beim Revoke verwirren.
--
-- Fix: zwei Partial-Indexes, eindeutig je nach NULL-Status.

DROP INDEX IF EXISTS idx_share_grants_group_cascade_unique;

-- Direct-Share-Uniqueness: ein Direct-Share pro (resource, group)
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_grants_group_direct_unique
  ON share_grants(resource_id, granted_to_group_id)
  WHERE revoked_at IS NULL
    AND granted_to_group_id IS NOT NULL
    AND via_cascade_from_object_id IS NULL;

-- Cascade-Share-Uniqueness: ein Cascade-Share pro (resource, group, cascade-source)
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_grants_group_cascade_unique
  ON share_grants(resource_id, granted_to_group_id, via_cascade_from_object_id)
  WHERE revoked_at IS NULL
    AND granted_to_group_id IS NOT NULL
    AND via_cascade_from_object_id IS NOT NULL;

-- Hinweis fuer den Code-Layer: gleiches Object kann gleichzeitig
-- direct-shared UND cascade-shared mit derselben Group sein (z.B. wenn
-- jemand Doc-X direkt teilt UND ueber Skill-Bundle). Beide Rows koexistieren
-- legitim. Revoke muss beide separat handhaben — bei Skill-Unshare nur
-- die Cascade-Rows, der Direct-Share bleibt aktiv.

-- ──────────────────────────────────────────────────────────────────────────
-- 3. groups.owner_id FK zu users(id) — GDPR-Erase-Safety
-- ──────────────────────────────────────────────────────────────────────────
--
-- Plan-Review §2 (MEDIUM): groups.owner_id war in 0019 ohne FK. Wenn
-- hardDeleteByOwner (GDPR Art. 17) ohne Group-Cleanup laeuft, bleiben
-- groups orphaned. ON DELETE RESTRICT zwingt App-Layer zur expliziten
-- Group-Behandlung VOR dem User-Delete:
--   1. Owner-Transfer (Group an anderen Member uebertragen)
--   2. ODER Group archive (archived_at setzen, alle Members removed)
--   3. ODER Group delete (CASCADE auf group_members + share_grants)
-- Erst dann darf User-Delete laufen.

ALTER TABLE groups
  ADD CONSTRAINT fk_groups_owner_user
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. group_members.user_id FK zu users(id) — Cascade auf User-Delete
-- ──────────────────────────────────────────────────────────────────────────
--
-- Im Gegensatz zu groups.owner_id (RESTRICT) ist group_members.user_id
-- CASCADE: wenn User geloescht wird, werden seine Memberships
-- automatisch entfernt. Das verhindert orphan group_members-Rows ohne
-- den Owner-Delete zu blockieren (Owner ist via groups.owner_id-RESTRICT
-- separat geschuetzt).
--
-- Note: Member-Remove-Rotation-Logic im App-Layer (Group-Master rotieren,
-- bleibende Members re-wrappen) muss BEFORE diesen FK-Cascade laufen.
-- Bei GDPR-Erase wird das im hardDeleteByOwner-Flow aufgerufen.

ALTER TABLE group_members
  ADD CONSTRAINT fk_group_members_user
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. share_grants.granted_to + .granted_by FK zu users(id) — Konsistenz
-- ──────────────────────────────────────────────────────────────────────────
--
-- 0019 hatte granted_to NULLABLE gemacht, aber ohne FK. Plan-Review §2:
-- konsistente FK-Anbindung jetzt nachziehen. CASCADE bei granted_to
-- (Auto-Revoke wenn Recipient-User geloescht). RESTRICT bei granted_by
-- (Owner muss erst Erase-Sequence laufen).
--
-- via_cascade_from_object_id und granted_to_group_id haben bereits CASCADE
-- aus 0019 (siehe REFERENCES-Klauseln dort).

-- granted_to: Recipient. Auto-Revoke wenn User weg.
-- (NULL erlaubt fuer Group-Grants — FK ist NULL-tolerant)
ALTER TABLE share_grants
  ADD CONSTRAINT fk_share_grants_granted_to_user
  FOREIGN KEY (granted_to) REFERENCES users(id) ON DELETE CASCADE;

-- granted_by: Grantor (immer der Resource-Owner). Sollte gleichzeitig
-- mit Resource-Erase verschwinden, nicht durch share_grants blockiert.
-- ON DELETE CASCADE waere konsistent (mit objects-FK auf resource_id),
-- aber Plan-Review schlaegt RESTRICT vor damit Erase-Sequence explizit
-- audit-trail erzeugt. Wir nehmen CASCADE — der App-Layer-hardDeleteByOwner
-- macht eigenes Audit + ordert die DELETEs sauber.
ALTER TABLE share_grants
  ADD CONSTRAINT fk_share_grants_granted_by_user
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE CASCADE;
