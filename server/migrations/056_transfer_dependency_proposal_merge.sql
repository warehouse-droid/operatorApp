ALTER TABLE scm_transfer_dependency_proposals
  ADD COLUMN IF NOT EXISTS merged_into_proposal_id bigint,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_transfer_dependency_proposals_merged_into_fkey'
  ) THEN
    ALTER TABLE scm_transfer_dependency_proposals
      ADD CONSTRAINT scm_transfer_dependency_proposals_merged_into_fkey
      FOREIGN KEY (merged_into_proposal_id)
      REFERENCES scm_transfer_dependency_proposals(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_proposals_merged_into
  ON scm_transfer_dependency_proposals (merged_into_proposal_id)
  WHERE merged_into_proposal_id IS NOT NULL;

COMMENT ON COLUMN scm_transfer_dependency_proposals.merged_into_proposal_id IS
  'Replacement draft created when this proposal was merged. The cancelled source row and its lines are retained as audit lineage.';

COMMENT ON COLUMN scm_transfer_dependency_proposals.merged_at IS
  'Time this draft proposal was replaced by a merged proposal.';

COMMENT ON COLUMN scm_transfer_dependency_proposals.merged_by IS
  'Operator that merged this draft proposal into its replacement.';
