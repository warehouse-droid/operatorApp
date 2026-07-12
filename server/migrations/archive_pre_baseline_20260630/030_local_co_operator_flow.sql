CREATE TABLE IF NOT EXISTS local_co_orders (
  id bigserial PRIMARY KEY,
  co_ref text NOT NULL UNIQUE,
  source_order_ref text NOT NULL,
  from_location_id bigint,
  from_location text,
  to_location_id bigint,
  to_location text,
  status text NOT NULL DEFAULT 'planned',
  dispatch_plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  dispatch_plan_date date,
  dispatch_truck_plate text,
  dispatch_load_name text,
  dispatch_parking_spot text,
  delivery_order_id bigint UNIQUE,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  received_by text REFERENCES operators(id) ON DELETE SET NULL,
  received_at timestamptz,
  loaded_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS local_co_order_lines (
  id bigserial PRIMARY KEY,
  co_id bigint NOT NULL REFERENCES local_co_orders(id) ON DELETE CASCADE,
  line_id bigint NOT NULL,
  item_id bigint,
  item_name text,
  item_type text NOT NULL DEFAULT 'InvtPart',
  item_type_text text,
  item_description text,
  sku text,
  quantity numeric,
  unit text,
  pallet_qty numeric,
  layer_qty numeric,
  piece_qty numeric,
  section_qty numeric,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  received_pallet_qty numeric NOT NULL DEFAULT 0,
  received_layer_qty numeric NOT NULL DEFAULT 0,
  received_piece_qty numeric NOT NULL DEFAULT 0,
  received_section_qty numeric NOT NULL DEFAULT 0,
  confirmed_at timestamptz,
  confirmed_by text REFERENCES operators(id) ON DELETE SET NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (co_id, line_id)
);

CREATE TABLE IF NOT EXISTS local_co_receipt_records (
  id bigserial PRIMARY KEY,
  co_id bigint NOT NULL REFERENCES local_co_orders(id) ON DELETE CASCADE,
  operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_delivery_order_id bigint REFERENCES delivery_orders(netsuite_id) ON DELETE SET NULL,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_local_co_orders_status_destination
  ON local_co_orders (status, to_location_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_co_orders_source_order
  ON local_co_orders (source_order_ref, status);

CREATE INDEX IF NOT EXISTS idx_local_co_lines_item
  ON local_co_order_lines (item_name, sku);
