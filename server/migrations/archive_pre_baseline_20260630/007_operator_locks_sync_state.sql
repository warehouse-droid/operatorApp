ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS preparing_operator_id text,
  ADD COLUMN IF NOT EXISTS preparing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS netsuite_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS netsuite_missing_at timestamptz;

ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_active boolean NOT NULL DEFAULT true;

UPDATE delivery_orders
SET preparing_operator_id = 'legacy-preparing',
    preparing_started_at = COALESCE(status_updated_at, now())
WHERE operator_status = 'preparing'
  AND preparing_operator_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_orders_operator_lock
  ON delivery_orders (preparing_operator_id, operator_status);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_netsuite_active_location
  ON delivery_orders (netsuite_active, outbound_location_id, trandate DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_lines_netsuite_active_order
  ON delivery_order_lines (order_id, netsuite_active);
