ALTER TABLE scm_smart_blanket_release_events
  DROP CONSTRAINT IF EXISTS scm_smart_blanket_release_events_type_check;

ALTER TABLE scm_smart_blanket_release_events
  ADD CONSTRAINT scm_smart_blanket_release_events_type_check CHECK (
    event_type IN (
      'reserved', 'reservation_cancelled', 'vendor_finalized', 'split_created',
      'held', 'cancelled', 'alternative_added', 'alternative_removed',
      'vendor_destination_updated'
    )
  );

COMMENT ON CONSTRAINT scm_smart_blanket_release_events_type_check
  ON scm_smart_blanket_release_events IS
  'Durable lifecycle and Vendor Replies destination-change events for Blanket releases.';
