ALTER TABLE local_co_orders
  ADD COLUMN IF NOT EXISTS preparing_operator_id text,
  ADD COLUMN IF NOT EXISTS preparing_started_at timestamptz;

ALTER TABLE co_orders
  ADD COLUMN IF NOT EXISTS preparing_operator_id text,
  ADD COLUMN IF NOT EXISTS preparing_started_at timestamptz;

ALTER TABLE local_co_order_lines
  ADD COLUMN IF NOT EXISTS packed_pallet_qty numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS packed_layer_qty numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS packed_piece_qty numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS packed_section_qty numeric DEFAULT 0 NOT NULL;

ALTER TABLE co_order_lines
  ADD COLUMN IF NOT EXISTS packed_pallet_qty numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS packed_layer_qty numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS packed_piece_qty numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS packed_section_qty numeric DEFAULT 0 NOT NULL;
