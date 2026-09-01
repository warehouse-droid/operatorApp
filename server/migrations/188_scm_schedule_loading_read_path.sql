BEGIN;

-- PO/TO Schedule reads the compact assignment projection.  The kind is kept
-- inside the projection payload so a Sales Order assignment can never be
-- mistaken for a PO that happens to share its dispatch reference.
CREATE INDEX IF NOT EXISTS idx_dispatch_plan_assignments_schedule_kind_ref
  ON dispatch_plan_order_assignments (
    upper((assignment->>'dispatchOrderKind')),
    lower(order_ref),
    plan_date DESC,
    plan_id
  )
  WHERE upper(COALESCE(assignment->>'dispatchOrderKind', ''))
    IN ('PO', 'TO', 'VRMA');

CREATE INDEX IF NOT EXISTS idx_dispatch_vendor_mappings_active_vendor_id
  ON dispatch_vendor_mappings (netsuite_vendor_id, last_seen_at DESC, id DESC)
  WHERE active = true
    AND COALESCE(netsuite_vendor_id, '') <> ''
    AND COALESCE(local_vendor, '') <> '';

CREATE INDEX IF NOT EXISTS idx_dispatch_vendor_mappings_active_vendor_name
  ON dispatch_vendor_mappings (
    lower(netsuite_vendor_name),
    last_seen_at DESC,
    id DESC
  )
  WHERE active = true
    AND COALESCE(netsuite_vendor_name, '') <> ''
    AND COALESCE(local_vendor, '') <> '';

CREATE INDEX IF NOT EXISTS idx_dispatch_vendor_yards_active_vendor
  ON dispatch_vendor_yards (lower(vendor), lower(yard), id)
  WHERE active = true;

-- Projection payload version 2 adds dispatchOrderKind and dispatchEtaTime.
-- Invalidating only this rebuild marker makes the existing startup backfill
-- regenerate compact rows once; snapshots remain untouched and available for
-- rollback/audit.
DELETE FROM dispatch_plan_projection_state;

UPDATE dispatch_order_catalog_state
   SET assignments_ready = false,
       status = CASE WHEN status = 'ready' THEN 'warming' ELSE status END,
       updated_at = now()
 WHERE singleton = true;

COMMIT;
