CREATE TABLE IF NOT EXISTS dispatch_truck_location_history (
  id bigserial PRIMARY KEY,
  plate text NOT NULL,
  vehicle_id text,
  vehicle_name text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  heading_degrees double precision,
  speed_miles_per_hour double precision,
  formatted_location text,
  location_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plate, location_time)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_truck_location_history_plate_time
  ON dispatch_truck_location_history (plate, location_time DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_truck_location_history_time
  ON dispatch_truck_location_history (location_time DESC);
