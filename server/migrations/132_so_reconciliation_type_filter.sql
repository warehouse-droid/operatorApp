-- Persist the Sales Order delivery-method scope used by each reconciliation
-- run. Existing rows predate this filter and therefore retain all SO types.

ALTER TABLE scm_reconciliation_runs
  ADD COLUMN IF NOT EXISTS so_order_type_filter text NOT NULL DEFAULT 'all';

ALTER TABLE scm_reconciliation_runs
  DROP CONSTRAINT IF EXISTS scm_reconciliation_runs_so_order_type_filter,
  ADD CONSTRAINT scm_reconciliation_runs_so_order_type_filter
    CHECK (so_order_type_filter IN ('all', 'delivery', 'pickup'));

COMMENT ON COLUMN scm_reconciliation_runs.so_order_type_filter IS
  'Sales Order subset for this run: Delivery, Pick-Up, or historical/targeted all.';
