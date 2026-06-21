ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS operator_status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;

ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS pallet_qty numeric,
  ADD COLUMN IF NOT EXISTS layer_qty numeric,
  ADD COLUMN IF NOT EXISTS piece_qty numeric,
  ADD COLUMN IF NOT EXISTS section text;

UPDATE delivery_orders
SET operator_status = CASE WHEN prepared THEN 'packed' ELSE operator_status END
WHERE operator_status = 'open';

CREATE INDEX IF NOT EXISTS idx_delivery_orders_operator_status
  ON delivery_orders (operator_status, trandate DESC);
