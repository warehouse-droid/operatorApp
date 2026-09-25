ALTER TABLE aggregate_request_lines
  ADD COLUMN IF NOT EXISTS scm_memo text NOT NULL DEFAULT '' CHECK (char_length(scm_memo) <= 2000);

ALTER TABLE aggregate_request_events
  DROP CONSTRAINT IF EXISTS aggregate_request_events_action_check;
ALTER TABLE aggregate_request_events
  ADD CONSTRAINT aggregate_request_events_action_check
  CHECK (action IN ('submit','edit','confirm','reject','report','correct','acknowledge','memo'));
