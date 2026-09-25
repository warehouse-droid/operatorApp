-- Existing records keep their original approval and Credit Memo workflow.
ALTER TABLE return_records
  ADD COLUMN IF NOT EXISTS workflow_version smallint NOT NULL DEFAULT 1 CHECK (workflow_version IN (1, 2)),
  ADD COLUMN IF NOT EXISTS netsuite_posting_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS netsuite_ra_attempted_at timestamptz;

INSERT INTO mbt_feature_flags(flag_key, enabled, description)
SELECT 'operator_netsuite_' || kind || '_return_ra_' || yard, false,
       'Create a Return Authorization on Operator ' || kind || ' return confirmation at ' || yard || '.'
FROM unnest(ARRAY['stock','pallet']) AS kind
CROSS JOIN unnest(ARRAY['3445','2967','12441','150']) AS yard
ON CONFLICT (flag_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_return_records_ra_recovery
  ON return_records(updated_at, id)
  WHERE workflow_version = 2 AND netsuite_sync_status IN ('pending', 'failed');

COMMENT ON COLUMN return_records.netsuite_ra_attempted_at IS
  'Durable pre-create marker. An uncertain create is recovery-only until its external ID can be found.';
