-- A running worker must acknowledge a Stop request before its run releases the
-- one-running lock. This prevents a second process from starting while the
-- first worker is still finishing an atomic order update.

ALTER TABLE scm_reconciliation_runs
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_by text,
  ADD COLUMN IF NOT EXISTS cancel_request_note text;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_runs_cancel_requested
  ON scm_reconciliation_runs (cancel_requested_at)
  WHERE status = 'running'
    AND cancel_requested_at IS NOT NULL;

-- A saved Skip must remain durable even if a historical review target does not
-- yet have a current-state row.
WITH latest_decision AS (
  SELECT DISTINCT ON (target.order_kind, target.netsuite_order_id)
         target.order_kind,
         target.netsuite_order_id,
         COALESCE(
           NULLIF(BTRIM(target.order_ref), ''),
           target.netsuite_order_id::text
         ) AS order_ref,
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
INSERT INTO scm_reconciliation_order_state (
  order_kind,
  source_order_netsuite_id,
  source_order_ref,
  broad_reconciliation_skipped,
  broad_reconciliation_skipped_at,
  broad_reconciliation_skipped_by,
  broad_reconciliation_skip_note,
  updated_at
)
SELECT latest.order_kind,
       latest.netsuite_order_id,
       latest.order_ref,
       true,
       latest.review_decided_at,
       latest.review_decided_by,
       latest.review_decision_note,
       now()
  FROM latest_decision latest
 WHERE latest.review_decision = 'skip'
ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
  broad_reconciliation_skipped = true,
  broad_reconciliation_skipped_at = EXCLUDED.broad_reconciliation_skipped_at,
  broad_reconciliation_skipped_by = EXCLUDED.broad_reconciliation_skipped_by,
  broad_reconciliation_skip_note = EXCLUDED.broad_reconciliation_skip_note,
  updated_at = now();
