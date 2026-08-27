BEGIN;

ALTER TABLE scm_transport_schedule
  ADD COLUMN IF NOT EXISTS remark_override text;

ALTER TABLE scm_transport_schedule
  DROP CONSTRAINT IF EXISTS scm_transport_schedule_remark_override_length_check;

ALTER TABLE scm_transport_schedule
  ADD CONSTRAINT scm_transport_schedule_remark_override_length_check
  CHECK (remark_override IS NULL OR char_length(remark_override) <= 2000);

COMMENT ON COLUMN scm_transport_schedule.remark_override IS
  'Single local PO/TO Schedule remark. NULL inherits the current NetSuite Memo for Transfer Orders only.';

-- Existing planning labels remain in notes/dispatch_assignment_note. Do not
-- backfill them into remarks because they describe truck/load assignment.

COMMIT;
