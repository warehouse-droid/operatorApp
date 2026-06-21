ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS fulfillment_status text NOT NULL DEFAULT 'not_fulfilled',
  ADD COLUMN IF NOT EXISTS last_item_fulfillment_id bigint,
  ADD COLUMN IF NOT EXISTS last_item_fulfillment_tranid text,
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS fulfilled_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_section_qty numeric NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS delivery_fulfillment_records (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES delivery_orders(netsuite_id) ON DELETE CASCADE,
  operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  item_fulfillment_id bigint,
  item_fulfillment_tranid text,
  fulfillment_status text NOT NULL DEFAULT 'submitted',
  photo_data_url text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_fulfillment_records_order
  ON delivery_fulfillment_records (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_fulfillment_status
  ON delivery_orders (fulfillment_status, fulfilled_at DESC);
