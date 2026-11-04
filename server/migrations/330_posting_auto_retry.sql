-- Automatic retry of IF/IR posting after a timeout or lost connection.
-- Transfer background jobs retry their preparation (nothing has been sent to
-- NetSuite yet); posting commands repeat the Admin "Resume verification" step,
-- which checks NetSuite for the record before any further posting.
ALTER TABLE transfer_order_posting_jobs
  ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE transfer_order_posting_jobs DROP CONSTRAINT IF EXISTS transfer_order_posting_jobs_auto_retry_count_check;
ALTER TABLE transfer_order_posting_jobs ADD CONSTRAINT transfer_order_posting_jobs_auto_retry_count_check
  CHECK (auto_retry_count >= 0);

ALTER TABLE operator_netsuite_posting_commands
  ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_auto_retry_at timestamptz;
ALTER TABLE operator_netsuite_posting_commands DROP CONSTRAINT IF EXISTS operator_netsuite_posting_commands_auto_retry_count_check;
ALTER TABLE operator_netsuite_posting_commands ADD CONSTRAINT operator_netsuite_posting_commands_auto_retry_count_check
  CHECK (auto_retry_count >= 0);
-- A schedule is acted on only while the command is still in attention.
CREATE INDEX IF NOT EXISTS operator_netsuite_posting_commands_auto_retry_due
  ON operator_netsuite_posting_commands(next_auto_retry_at) WHERE next_auto_retry_at IS NOT NULL;
