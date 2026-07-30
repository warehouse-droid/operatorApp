-- Keep broad PO/TO reconciliation focused on locally active work while
-- preserving an explicit Admin override for historical/terminal orders.

ALTER TABLE scm_reconciliation_runs
  ADD COLUMN IF NOT EXISTS include_terminal_orders boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scm_reconciliation_runs.include_terminal_orders IS
  'Explicit Admin override. When false, locally Completed, Cancelled/closed, Hold, and persistently skipped orders are omitted.';

ALTER TABLE scm_reconciliation_order_state
  ADD COLUMN IF NOT EXISTS broad_reconciliation_skipped boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS broad_reconciliation_skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS broad_reconciliation_skipped_by text,
  ADD COLUMN IF NOT EXISTS broad_reconciliation_skip_note text;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_order_state_broad_skip
  ON scm_reconciliation_order_state (order_kind, source_order_netsuite_id)
  WHERE broad_reconciliation_skipped = true;

-- Carry forward the latest saved Skip decision for each order. A later
-- non-Skip decision supersedes an older Skip.
WITH latest_decision AS (
  SELECT DISTINCT ON (target.order_kind, target.netsuite_order_id)
         target.order_kind,
         target.netsuite_order_id,
         target.review_decision,
         target.review_decision_note,
         target.review_decided_by,
         target.review_decided_at
    FROM scm_reconciliation_run_targets target
   WHERE target.review_decision IS NOT NULL
   ORDER BY target.order_kind,
            target.netsuite_order_id,
            target.review_decided_at DESC NULLS LAST,
            target.id DESC
)
UPDATE scm_reconciliation_order_state state
   SET broad_reconciliation_skipped =
         latest.review_decision = 'skip',
       broad_reconciliation_skipped_at =
         CASE WHEN latest.review_decision = 'skip'
           THEN latest.review_decided_at
           ELSE NULL
         END,
       broad_reconciliation_skipped_by =
         CASE WHEN latest.review_decision = 'skip'
           THEN latest.review_decided_by
           ELSE NULL
         END,
       broad_reconciliation_skip_note =
         CASE WHEN latest.review_decision = 'skip'
           THEN latest.review_decision_note
           ELSE NULL
         END,
       updated_at = now()
  FROM latest_decision latest
 WHERE state.order_kind = latest.order_kind
   AND state.source_order_netsuite_id = latest.netsuite_order_id;
