ALTER TABLE scm_vrma_orders
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancellation_note text,
  ADD COLUMN IF NOT EXISTS cancellation_source text;

COMMENT ON COLUMN scm_vrma_orders.cancelled_at IS
  'Time an SCM/Admin user removed this local-only VRMA by soft cancellation.';

COMMENT ON COLUMN scm_vrma_orders.cancelled_by IS
  'Operator ID that removed this local-only VRMA.';

COMMENT ON COLUMN scm_vrma_orders.cancellation_note IS
  'Required audit explanation for removing this local-only VRMA.';

COMMENT ON COLUMN scm_vrma_orders.cancellation_source IS
  'Local cancellation mechanism. A removed VRMA is retained for audit and is never hard-deleted.';
