ALTER TABLE scm_smart_item_yard_policies
  ADD COLUMN IF NOT EXISTS capacity_manually_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS capacity_source text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS capacity_source_input_file_id bigint REFERENCES scm_smart_input_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capacity_source_sheet text,
  ADD COLUMN IF NOT EXISTS capacity_source_row integer,
  ADD COLUMN IF NOT EXISTS capacity_match_method text;

-- The former manually_overridden flag covered several policy fields, so it
-- cannot prove that capacity itself was edited. Keep legacy rows refreshable;
-- only explicit capacity edits made after this migration become manual.
UPDATE scm_smart_item_yard_policies
   SET capacity_source = 'legacy_import'
 WHERE capacity_pallets IS DISTINCT FROM 25
   AND capacity_source = 'default';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scm_smart_item_yard_capacity_source_check'
       AND conrelid = 'scm_smart_item_yard_policies'::regclass
  ) THEN
    ALTER TABLE scm_smart_item_yard_policies
      ADD CONSTRAINT scm_smart_item_yard_capacity_source_check
      CHECK (capacity_source IN ('default', 'decision_workbook', 'manual', 'legacy_import'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scm_smart_item_yard_capacity_source
  ON scm_smart_item_yard_policies (capacity_source, capacity_manually_overridden, item_id, location_id);

CREATE TABLE IF NOT EXISTS scm_smart_capacity_import_rows (
  id bigserial PRIMARY KEY,
  source_input_file_id bigint NOT NULL REFERENCES scm_smart_input_files(id) ON DELETE CASCADE,
  yard_code text NOT NULL,
  location_id bigint NOT NULL,
  sheet_name text NOT NULL,
  source_row integer NOT NULL,
  item_id bigint,
  capacity_pallets numeric,
  mapping_status text NOT NULL,
  match_method text,
  signature text,
  candidate_item_ids bigint[] NOT NULL DEFAULT '{}'::bigint[],
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_capacity_import_row_number CHECK (source_row > 1),
  CONSTRAINT scm_smart_capacity_import_nonnegative CHECK (capacity_pallets IS NULL OR capacity_pallets >= 0),
  UNIQUE (source_input_file_id, sheet_name, source_row)
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_capacity_import_status
  ON scm_smart_capacity_import_rows (source_input_file_id, mapping_status, yard_code, source_row);

COMMENT ON COLUMN scm_smart_item_yard_policies.capacity_manually_overridden IS
  'True only when an operator changed capacity itself; unrelated Item Master edits must not block decision-workbook capacity refreshes.';

COMMENT ON TABLE scm_smart_capacity_import_rows IS
  'Row-level provenance for *_Cal capacity reconciliation, including unresolved rows that must remain at a known default instead of being guessed.';
