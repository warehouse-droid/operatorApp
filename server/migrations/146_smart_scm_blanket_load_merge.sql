ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS merged_into_proposal_id bigint
    REFERENCES scm_smart_proposals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_by text;

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_merged_into
  ON scm_smart_proposals (merged_into_proposal_id, id)
  WHERE merged_into_proposal_id IS NOT NULL;

COMMENT ON COLUMN scm_smart_proposals.merged_into_proposal_id IS
  'Replacement proposal that owns the active load after compatible Blanket proposals are merged.';

COMMENT ON COLUMN scm_smart_proposals.merged_at IS
  'Time this proposal was superseded by an explicit Blanket-load merge.';

COMMENT ON COLUMN scm_smart_proposals.merged_by IS
  'Operator who explicitly merged this Blanket load into its replacement.';
