ALTER TABLE scm_smart_item_yard_policies
  ALTER COLUMN capacity_pallets DROP NOT NULL,
  ALTER COLUMN capacity_pallets DROP DEFAULT;

-- Capacity is meaningful only for yards that participate in planning. This is
-- the one-time cleanup for values imported before eligibility and capacity
-- were coupled.
UPDATE scm_smart_item_yard_policies
   SET capacity_pallets = NULL,
       capacity_manually_overridden = false,
       capacity_source = 'default',
       capacity_source_input_file_id = NULL,
       capacity_source_sheet = NULL,
       capacity_source_row = NULL,
       capacity_match_method = NULL,
       updated_at = now()
 WHERE eligible = false
   AND (
     capacity_pallets IS NOT NULL
     OR capacity_manually_overridden = true
     OR capacity_source IS DISTINCT FROM 'default'
     OR capacity_source_input_file_id IS NOT NULL
     OR capacity_source_sheet IS NOT NULL
     OR capacity_source_row IS NOT NULL
     OR capacity_match_method IS NOT NULL
   );

-- Preserve the historical 25-pallet default for any malformed eligible row
-- before installing the conditional invariant.
UPDATE scm_smart_item_yard_policies
   SET capacity_pallets = 25,
       capacity_manually_overridden = false,
       capacity_source = 'default',
       capacity_source_input_file_id = NULL,
       capacity_source_sheet = NULL,
       capacity_source_row = NULL,
       capacity_match_method = NULL,
       updated_at = now()
 WHERE eligible = true
   AND capacity_pallets IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_smart_item_yard_capacity_eligibility'
       AND conrelid = 'scm_smart_item_yard_policies'::regclass
  ) THEN
    ALTER TABLE scm_smart_item_yard_policies
      ADD CONSTRAINT scm_smart_item_yard_capacity_eligibility
      CHECK (
        (eligible = false AND capacity_pallets IS NULL)
        OR
        (eligible = true AND capacity_pallets IS NOT NULL AND capacity_pallets >= 0)
      );
  END IF;
END $$;

COMMENT ON COLUMN scm_smart_item_yard_policies.capacity_pallets IS
  'Planning capacity in pallets. Must be NULL when the item is not eligible at this yard.';
