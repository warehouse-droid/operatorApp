ALTER TABLE scm_transfer_dependency_proposals
  ADD COLUMN IF NOT EXISTS creation_attempt_id text,
  ADD COLUMN IF NOT EXISTS creation_started_at timestamptz;

UPDATE scm_transfer_dependency_proposals
   SET creation_started_at = COALESCE(creation_started_at, updated_at)
 WHERE creation_status = 'creating'
   AND creation_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_proposals_creating
  ON scm_transfer_dependency_proposals (creation_status, creation_started_at)
  WHERE creation_status = 'creating';

COMMENT ON COLUMN scm_transfer_dependency_proposals.creation_attempt_id IS
  'Durable claim token used to prevent concurrent or repeated NetSuite TO creation.';

COMMENT ON COLUMN scm_transfer_dependency_proposals.creation_started_at IS
  'Start time of the current NetSuite TO creation attempt, retained across process restarts for reconciliation.';
