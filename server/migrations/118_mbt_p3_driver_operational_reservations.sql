-- Phase 3.9 Driver BIN pickup/exchange reservation states.
--
-- Existing delivery reservations remain reserved at a yard/truck. A loaded
-- pickup or exchange must also be able to reserve the exact customer asset
-- before Dispatch confirmation, without falsifying its physical location.
-- This migration changes no current row and enables no capability.

SET LOCAL lock_timeout = '3s';

ALTER TABLE mbt_bin_asset_state
  DROP CONSTRAINT IF EXISTS mbt_bin_asset_state_status_location;

ALTER TABLE mbt_bin_asset_state
  ADD CONSTRAINT mbt_bin_asset_state_status_location
    CHECK (
      (lifecycle_status = 'available' AND location_kind = 'yard')
      OR (lifecycle_status = 'reserved' AND location_kind IN (
        'yard', 'truck', 'customer_site', 'dump_site'
      ))
      OR (lifecycle_status = 'on_truck' AND location_kind = 'truck')
      OR (lifecycle_status = 'at_customer' AND location_kind = 'customer_site')
      OR (lifecycle_status = 'at_dump' AND location_kind = 'dump_site')
      OR (lifecycle_status = 'maintenance' AND location_kind IN ('yard', 'unknown'))
      OR (lifecycle_status = 'lost' AND location_kind = 'unknown')
      OR (lifecycle_status = 'retired' AND location_kind IN ('yard', 'unknown'))
    );

COMMENT ON CONSTRAINT mbt_bin_asset_state_status_location ON mbt_bin_asset_state IS
  'Reserved assets retain their exact operational location for delivery, pickup, dump, and exchange planning.';
