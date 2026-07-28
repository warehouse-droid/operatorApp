CREATE TABLE IF NOT EXISTS dispatch_custom_orders (
  id bigserial PRIMARY KEY,
  ref_number text NOT NULL,
  pickup_location text NOT NULL,
  dropoff_location text NOT NULL,
  order_details text NOT NULL,
  weight_lbs numeric(14, 3) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  cancelled_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT dispatch_custom_orders_ref_not_blank CHECK (btrim(ref_number) <> ''),
  CONSTRAINT dispatch_custom_orders_ref_length CHECK (char_length(ref_number) <= 100),
  CONSTRAINT dispatch_custom_orders_ref_format CHECK (ref_number ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]*$'),
  CONSTRAINT dispatch_custom_orders_pickup_not_blank CHECK (btrim(pickup_location) <> ''),
  CONSTRAINT dispatch_custom_orders_pickup_length CHECK (char_length(pickup_location) <= 500),
  CONSTRAINT dispatch_custom_orders_dropoff_not_blank CHECK (btrim(dropoff_location) <> ''),
  CONSTRAINT dispatch_custom_orders_dropoff_length CHECK (char_length(dropoff_location) <= 500),
  CONSTRAINT dispatch_custom_orders_details_not_blank CHECK (btrim(order_details) <> ''),
  CONSTRAINT dispatch_custom_orders_details_length CHECK (char_length(order_details) <= 5000),
  CONSTRAINT dispatch_custom_orders_weight_valid CHECK (weight_lbs > 0 AND weight_lbs <= 1000000),
  CONSTRAINT dispatch_custom_orders_status_valid CHECK (status IN ('open', 'completed', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_custom_orders_ref_unique
  ON dispatch_custom_orders (lower(btrim(ref_number)));

CREATE INDEX IF NOT EXISTS idx_dispatch_custom_orders_status_created
  ON dispatch_custom_orders (status, created_at DESC);

COMMENT ON TABLE dispatch_custom_orders IS
  'Dispatcher-created transportation work that does not originate in NetSuite.';
