ALTER TABLE scm_vrma_orders
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_by text,
  ADD COLUMN IF NOT EXISTS completion_note text,
  ADD COLUMN IF NOT EXISTS completion_source text;

COMMENT ON COLUMN scm_vrma_orders.completed_at IS
  'Time an SCM/Admin user explicitly marked this local-only VRMA Completed.';

COMMENT ON COLUMN scm_vrma_orders.completed_by IS
  'Operator ID that explicitly completed this local-only VRMA.';

COMMENT ON COLUMN scm_vrma_orders.completion_note IS
  'Required audit explanation for the explicit VRMA completion.';

COMMENT ON COLUMN scm_vrma_orders.completion_source IS
  'Local completion mechanism. This value is never synchronized to NetSuite.';
