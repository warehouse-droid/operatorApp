ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS line_order jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(line_order) = 'array');

COMMENT ON COLUMN scm_smart_proposals.line_order IS
  'SCM display/submission sequence: line:<proposal-line-id> and pallet:<destination-location-id>.';
