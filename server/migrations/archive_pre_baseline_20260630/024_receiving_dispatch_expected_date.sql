ALTER TABLE receiving_orders
  ADD COLUMN IF NOT EXISTS expected_delivery_date date;

CREATE INDEX IF NOT EXISTS idx_receiving_orders_expected_delivery_date
  ON receiving_orders (expected_delivery_date, order_type, netsuite_active);
