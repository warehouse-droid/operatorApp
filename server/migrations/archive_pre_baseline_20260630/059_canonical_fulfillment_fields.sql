ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS last_item_fulfillment_id bigint,
  ADD COLUMN IF NOT EXISTS last_item_fulfillment_tranid text,
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

ALTER TABLE transfer_orders
  ADD COLUMN IF NOT EXISTS last_item_fulfillment_id bigint,
  ADD COLUMN IF NOT EXISTS last_item_fulfillment_tranid text,
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

ALTER TABLE sales_order_lines
  ADD COLUMN IF NOT EXISTS fulfilled_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_section_qty numeric NOT NULL DEFAULT 0;

ALTER TABLE transfer_order_lines
  ADD COLUMN IF NOT EXISTS fulfilled_pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfilled_section_qty numeric NOT NULL DEFAULT 0;
