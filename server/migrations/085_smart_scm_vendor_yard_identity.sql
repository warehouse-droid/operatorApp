ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS source_vendor_yard_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_smart_proposals_source_vendor_yard_fk'
       AND conrelid = 'scm_smart_proposals'::regclass
  ) THEN
    ALTER TABLE scm_smart_proposals
      ADD CONSTRAINT scm_smart_proposals_source_vendor_yard_fk
      FOREIGN KEY (source_vendor_yard_id)
      REFERENCES dispatch_vendor_yards(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_source_vendor_yard
  ON scm_smart_proposals (source_vendor_yard_id)
  WHERE source_vendor_yard_id IS NOT NULL;

-- Preserve customized rules that were saved under a legacy pickup label. Only
-- copy a rule when that legacy label maps to exactly one canonical vendor yard.
WITH raw_mappings AS (
  SELECT DISTINCT
         regexp_replace(lower(BTRIM(policy.vendor_yard)), '[^a-z0-9]+', '', 'g') AS legacy_key,
         regexp_replace(lower(BTRIM(vendor_yard.yard)), '[^a-z0-9]+', '', 'g') AS canonical_key,
         BTRIM(vendor_yard.yard) AS canonical_name
    FROM scm_smart_item_policies policy
    JOIN dispatch_vendor_yards vendor_yard ON vendor_yard.id = policy.vendor_yard_id
   WHERE NULLIF(BTRIM(policy.vendor_yard), '') IS NOT NULL
     AND NULLIF(BTRIM(vendor_yard.yard), '') IS NOT NULL
), unambiguous_mappings AS (
  SELECT legacy_key,
         MIN(canonical_key) AS canonical_key,
         MIN(canonical_name) AS canonical_name
    FROM raw_mappings
   WHERE legacy_key <> canonical_key
     AND legacy_key <> ''
     AND canonical_key <> ''
   GROUP BY legacy_key
  HAVING COUNT(DISTINCT canonical_key) = 1
)
INSERT INTO scm_smart_route_rules (
  source_key, source_name, enabled, max_drops, stop_order,
  partial_redirect_enabled, partial_redirect_destination_ids,
  partial_redirect_hub_location_id, notes, updated_by, created_at, updated_at
)
SELECT mapping.canonical_key,
       mapping.canonical_name,
       rule.enabled,
       rule.max_drops,
       rule.stop_order,
       rule.partial_redirect_enabled,
       rule.partial_redirect_destination_ids,
       rule.partial_redirect_hub_location_id,
       rule.notes,
       rule.updated_by,
       rule.created_at,
       rule.updated_at
  FROM unambiguous_mappings mapping
  JOIN scm_smart_route_rules rule ON rule.source_key = mapping.legacy_key
ON CONFLICT (source_key) DO NOTHING;

-- An assigned dispatch vendor-yard ID is authoritative. Keep the legacy plant
-- import value for provenance, but normalize the editable Item Master label.
UPDATE scm_smart_item_policies policy
   SET vendor_yard = BTRIM(vendor_yard.yard),
       updated_at = now()
  FROM dispatch_vendor_yards vendor_yard
 WHERE vendor_yard.id = policy.vendor_yard_id
   AND NULLIF(BTRIM(vendor_yard.yard), '') IS NOT NULL
   AND BTRIM(policy.vendor_yard) IS DISTINCT FROM BTRIM(vendor_yard.yard);

COMMENT ON COLUMN scm_smart_proposals.source_vendor_yard_id IS
  'Stable dispatch vendor-yard identity for PO pickup grouping. This is intentionally separate from the NetSuite inventory source_location_id used by TOs.';
