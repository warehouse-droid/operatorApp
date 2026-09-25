-- Completed requests keep their original dates and audit history. Only an
-- unfinished request occupies the yard, regardless of its delivery date.
-- Build the replacement first so conflicting legacy rows abort the migration.
CREATE UNIQUE INDEX IF NOT EXISTS aggregate_requests_one_unfinished_yard_idx
  ON aggregate_requests (yard_location_id)
  WHERE status IN ('submitted','confirmed');

ALTER TABLE aggregate_requests
  DROP CONSTRAINT IF EXISTS aggregate_requests_yard_location_id_service_date_key;
