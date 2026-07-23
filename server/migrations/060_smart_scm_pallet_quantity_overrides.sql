ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS pallet_quantity_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scm_smart_proposals
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_pallet_quantity_overrides_object;

ALTER TABLE scm_smart_proposals
  ADD CONSTRAINT scm_smart_proposals_pallet_quantity_overrides_object
  CHECK (jsonb_typeof(pallet_quantity_overrides) = 'object');

COMMENT ON COLUMN scm_smart_proposals.pallet_quantity_overrides IS
  'Explicit official PALLET quantities keyed by destination location ID. Missing key means automatic; zero is an intentional override.';
