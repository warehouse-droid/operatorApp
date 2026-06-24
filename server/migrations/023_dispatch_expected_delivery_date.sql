ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS expected_delivery_date date;

CREATE INDEX IF NOT EXISTS idx_delivery_orders_expected_delivery_date
  ON delivery_orders (expected_delivery_date, outbound_location_id, netsuite_active);
