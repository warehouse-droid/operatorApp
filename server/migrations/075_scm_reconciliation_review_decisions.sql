ALTER TABLE scm_reconciliation_run_targets
  ADD COLUMN IF NOT EXISTS review_decision text,
  ADD COLUMN IF NOT EXISTS review_decision_note text,
  ADD COLUMN IF NOT EXISTS review_decision_fingerprint text,
  ADD COLUMN IF NOT EXISTS review_decided_by text,
  ADD COLUMN IF NOT EXISTS review_decided_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_reconciliation_run_targets_review_decision'
       AND conrelid = 'scm_reconciliation_run_targets'::regclass
  ) THEN
    ALTER TABLE scm_reconciliation_run_targets
      ADD CONSTRAINT scm_reconciliation_run_targets_review_decision
      CHECK (
        review_decision IS NULL
        OR review_decision IN ('skip', 'accept_current', 'keep_review')
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_run_targets_pending_decision
  ON scm_reconciliation_run_targets (run_id, order_kind, netsuite_order_id)
  WHERE status = 'review'
    AND review_decision IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_reconciliation_runs_live_proposal_apply
  ON scm_reconciliation_runs (resume_of_run_id)
  WHERE dry_run = false
    AND resume_of_run_id IS NOT NULL
    AND status IN ('queued', 'running', 'succeeded');

COMMENT ON COLUMN scm_reconciliation_run_targets.review_decision IS
  'Admin decision recorded against a completed dry-run review before its scope can be applied.';
