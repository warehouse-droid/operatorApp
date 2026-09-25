-- A separate grant with one designated requester (or none) per yard.
CREATE TABLE IF NOT EXISTS aggregate_request_yard_assignments (
  yard_location_id integer PRIMARY KEY CHECK (yard_location_id IN (1,28,15,26)),
  operator_id text REFERENCES operators(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by text REFERENCES operators(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO aggregate_request_yard_assignments (yard_location_id)
VALUES (1),(28),(15),(26) ON CONFLICT (yard_location_id) DO NOTHING;
