ALTER TABLE scm_transfer_dependency_proposals
  ADD COLUMN IF NOT EXISTS quantity_verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS quantity_verification_error text,
  ADD COLUMN IF NOT EXISTS quantity_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS quantity_verified_by text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approval_error text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS print_job_id bigint REFERENCES scm_print_jobs(id) ON DELETE SET NULL;

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_verification_status_check;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_verification_status_check CHECK (
    quantity_verification_status IN ('pending', 'verified', 'failed')
  );

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_approval_status_check;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_approval_status_check CHECK (
    approval_status IN ('pending', 'approving', 'approved', 'failed')
  );

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_proposals_workflow
  ON scm_transfer_dependency_proposals (batch_id, approval_status, print_job_id)
  WHERE netsuite_transfer_order_id IS NOT NULL;

COMMENT ON COLUMN scm_transfer_dependency_proposals.print_job_id IS
  'Source-yard picking-ticket job queued only after exact NetSuite TO quantity verification and approval.';
