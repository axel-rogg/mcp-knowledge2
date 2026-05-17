-- AS-3 K12: audit_log gets via_proxy + approval_id columns.
--
-- Spec: PLAN-as3-autonomous.md §1.5.
--
-- When approval2 forwards a call via the OBO pattern (K7), audit_log marks
-- the row with via_proxy=true and the approval_id used. Direct Claude.ai
-- calls record via_proxy=false / approval_id=NULL.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS via_proxy   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS approval_id UUID;

CREATE INDEX IF NOT EXISTS idx_audit_via_proxy ON audit_log (via_proxy, ts) WHERE via_proxy = TRUE;
CREATE INDEX IF NOT EXISTS idx_audit_approval  ON audit_log (approval_id)  WHERE approval_id IS NOT NULL;
