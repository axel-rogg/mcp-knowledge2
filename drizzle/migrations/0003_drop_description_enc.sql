-- F-22 from 2026-05-13 audit: description_enc/_nonce/_key_version were dead
-- weight.
--
-- Rationale: the FTS pipeline (search_tsv on objects.description plain text
-- + tsvector GIN index) requires the description to be queryable in
-- plaintext. We were also writing the encrypted variant — paying both the
-- crypto cost and the at-rest secrecy guarantee, while the plaintext was
-- right next to it in the same row. The encryption layer did nothing.
--
-- Decision: be honest. description / title / keywords / trigger_hints are
-- discovery metadata, stored plaintext, indexed for FTS. Sensitive content
-- belongs in `body` which IS encrypted with the per-user DEK + AAD.
-- docs/SECURITY.md is updated in lockstep with this migration.

ALTER TABLE objects
  DROP COLUMN IF EXISTS description_enc,
  DROP COLUMN IF EXISTS description_nonce,
  DROP COLUMN IF EXISTS description_key_version;
