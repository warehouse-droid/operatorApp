ALTER TABLE scm_transfer_dependency_proposals
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS revision_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS revision_request_id text,
  ADD COLUMN IF NOT EXISTS revision_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision_error text,
  ADD COLUMN IF NOT EXISTS print_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS print_request_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS print_request_id text,
  ADD COLUMN IF NOT EXISTS print_request_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS print_request_error text;

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_revision_positive;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_revision_positive CHECK (revision > 0);

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_revision_status_check;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_revision_status_check CHECK (
    revision_status IN ('idle', 'updating', 'attention')
  );

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_print_generation_nonnegative;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_print_generation_nonnegative CHECK (print_generation >= 0);

ALTER TABLE scm_transfer_dependency_proposals
  DROP CONSTRAINT IF EXISTS scm_transfer_dependency_proposals_print_request_status_check;

ALTER TABLE scm_transfer_dependency_proposals
  ADD CONSTRAINT scm_transfer_dependency_proposals_print_request_status_check CHECK (
    print_request_status IN ('idle', 'queueing', 'attention')
  );

CREATE TABLE IF NOT EXISTS scm_transfer_dependency_revisions (
  id bigserial PRIMARY KEY,
  proposal_id bigint NOT NULL REFERENCES scm_transfer_dependency_proposals(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  expected_revision integer NOT NULL,
  target_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'updating',
  request_payload jsonb NOT NULL,
  error text,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT scm_transfer_dependency_revisions_revision_check CHECK (
    expected_revision > 0 AND target_revision = expected_revision + 1
  ),
  CONSTRAINT scm_transfer_dependency_revisions_status_check CHECK (
    status IN ('updating', 'applied', 'attention')
  ),
  UNIQUE (proposal_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_revisions_proposal
  ON scm_transfer_dependency_revisions (proposal_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_transfer_dependency_revisions_active
  ON scm_transfer_dependency_revisions (proposal_id)
  WHERE status IN ('updating', 'attention');

COMMENT ON TABLE scm_transfer_dependency_revisions IS
  'Durable idempotency and recovery ledger for PATCHing quantities on an existing NetSuite dependency Transfer Order.';

COMMENT ON COLUMN scm_transfer_dependency_proposals.print_generation IS
  'Monotonic picking-ticket snapshot number. Every deliberate reprint receives a new immutable scm_print_jobs key.';
