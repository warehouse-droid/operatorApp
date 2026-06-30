ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS packed_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packed_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packed_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_delivery_orders_location_status
  ON delivery_orders (outbound_location_id, operator_status, trandate DESC);
