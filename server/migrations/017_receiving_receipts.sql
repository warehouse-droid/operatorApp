ALTER TABLE receiving_orders
  ADD COLUMN IF NOT EXISTS receipt_status text NOT NULL DEFAULT 'not_received',
  ADD COLUMN IF NOT EXISTS last_item_receipt_id bigint,
  ADD COLUMN IF NOT EXISTS last_item_receipt_tranid text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

ALTER TABLE receiving_order_lines
  ADD COLUMN IF NOT EXISTS received_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_section_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by text REFERENCES operators(id);

CREATE TABLE IF NOT EXISTS receiving_receipt_records (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES receiving_orders(netsuite_id) ON DELETE CASCADE,
  operator_id text REFERENCES operators(id),
  item_receipt_id bigint,
  item_receipt_tranid text,
  receipt_status text NOT NULL DEFAULT 'submitted',
  photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receiving_receipt_records_order
  ON receiving_receipt_records (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receiving_orders_receipt_status
  ON receiving_orders (receipt_status, received_at DESC);
