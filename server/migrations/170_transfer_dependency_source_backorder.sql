ALTER TABLE scm_transfer_dependency_proposals
  ADD COLUMN IF NOT EXISTS allow_source_backorder boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scm_transfer_dependency_proposals.allow_source_backorder IS
  'Explicit SCM authorization for this proposed Transfer Order to exceed current source Available quantity; default false and audited on change/creation.';
