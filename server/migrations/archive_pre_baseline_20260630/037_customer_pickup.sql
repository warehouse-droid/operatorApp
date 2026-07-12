ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS pickup_loaded_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pickup_loaded_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pickup_loaded_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pickup_loaded_section_qty numeric NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS customer_pickup_load_records (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES delivery_orders(netsuite_id) ON DELETE CASCADE,
  operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  photo_data_url text NOT NULL,
  loaded_pallet_qty numeric NOT NULL DEFAULT 0,
  loaded_layer_qty numeric NOT NULL DEFAULT 0,
  loaded_piece_qty numeric NOT NULL DEFAULT 0,
  loaded_section_qty numeric NOT NULL DEFAULT 0,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_pickup_load_records_order
  ON customer_pickup_load_records (order_id, created_at DESC);
