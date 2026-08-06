-- Sales Orders use the same durable skip/review state as Purchase and
-- Transfer Orders. Migration 131 extended the run/audit ledgers to SO but
-- omitted this existing state-table constraint.

ALTER TABLE scm_reconciliation_order_state
  DROP CONSTRAINT IF EXISTS scm_reconciliation_order_state_order_kind_check,
  ADD CONSTRAINT scm_reconciliation_order_state_order_kind_check
    CHECK (order_kind IN ('SO', 'PO', 'TO'));
