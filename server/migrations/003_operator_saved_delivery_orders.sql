CREATE TABLE IF NOT EXISTS operator_saved_delivery_orders (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  location_id bigint NOT NULL,
  order_key text NOT NULL,
  order_ref text NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('sales_order', 'transfer_order', 'group_order')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, location_id, order_key)
);

CREATE INDEX IF NOT EXISTS idx_operator_saved_delivery_orders_operator_location
  ON operator_saved_delivery_orders (operator_id, location_id, created_at DESC);
