CREATE TABLE IF NOT EXISTS inventory_items (
  item_id bigint PRIMARY KEY,
  item_name text NOT NULL,
  display_name text,
  item_description text,
  item_type text,
  item_type_text text,
  stock_unit text,
  product_type text,
  brand text,
  series text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_balances (
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE CASCADE,
  location_id bigint NOT NULL,
  location text,
  quantity_on_hand numeric NOT NULL DEFAULT 0,
  quantity_available numeric NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id)
);

CREATE TABLE IF NOT EXISTS cycle_count_records (
  id bigserial PRIMARY KEY,
  operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cycle_count_status_check CHECK (status IN ('draft', 'submitted'))
);

CREATE TABLE IF NOT EXISTS cycle_count_lines (
  id bigserial PRIMARY KEY,
  record_id bigint NOT NULL REFERENCES cycle_count_records(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  location_id bigint NOT NULL,
  counted_pallet_qty numeric NOT NULL DEFAULT 0,
  counted_layer_qty numeric NOT NULL DEFAULT 0,
  system_on_hand_qty numeric,
  system_available_qty numeric,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, item_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_filters
  ON inventory_items (product_type, brand, series, item_name);

CREATE INDEX IF NOT EXISTS idx_inventory_balances_location
  ON inventory_balances (location_id, item_id);

CREATE INDEX IF NOT EXISTS idx_cycle_count_records_operator
  ON cycle_count_records (operator_id, status, updated_at DESC);
