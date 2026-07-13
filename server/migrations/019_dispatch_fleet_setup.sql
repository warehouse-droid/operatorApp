CREATE TABLE IF NOT EXISTS dispatch_drivers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  license_class text NOT NULL DEFAULT '',
  license_number text NOT NULL DEFAULT '',
  login text NOT NULL,
  password_hash text,
  password_salt text,
  samsara_primary_login text NOT NULL DEFAULT '',
  samsara_secondary_login text NOT NULL DEFAULT '',
  own_yard_fixed_minutes numeric(8, 2) NOT NULL DEFAULT 40,
  vendor_fixed_minutes numeric(8, 2) NOT NULL DEFAULT 35,
  delivery_fixed_minutes numeric(8, 2) NOT NULL DEFAULT 35,
  minutes_per_pallet numeric(8, 2) NOT NULL DEFAULT 1,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_drivers_login_not_blank CHECK (btrim(login) <> ''),
  CONSTRAINT dispatch_drivers_timing_nonnegative CHECK (
    own_yard_fixed_minutes >= 0
    AND vendor_fixed_minutes >= 0
    AND delivery_fixed_minutes >= 0
    AND minutes_per_pallet >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_drivers_login_unique
  ON dispatch_drivers (lower(btrim(login)));

CREATE INDEX IF NOT EXISTS idx_dispatch_drivers_active_order
  ON dispatch_drivers (active, display_order, id);

CREATE TABLE IF NOT EXISTS dispatch_trucks (
  id bigserial PRIMARY KEY,
  plate text NOT NULL,
  capacity_lbs numeric(14, 2) NOT NULL DEFAULT 48000,
  travel_time_percent numeric(8, 3) NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_trucks_plate_not_blank CHECK (btrim(plate) <> ''),
  CONSTRAINT dispatch_trucks_capacity_positive CHECK (capacity_lbs > 0),
  CONSTRAINT dispatch_trucks_travel_percent_nonnegative CHECK (travel_time_percent >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_trucks_plate_unique
  ON dispatch_trucks (upper(btrim(plate)));

CREATE INDEX IF NOT EXISTS idx_dispatch_trucks_active_order
  ON dispatch_trucks (active, display_order, id);
