ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS dispatch_pickup_address text NOT NULL DEFAULT '';

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS dispatch_pickup_address text NOT NULL DEFAULT '';

ALTER TABLE transfer_orders
  ADD COLUMN IF NOT EXISTS dispatch_pickup_address text NOT NULL DEFAULT '';

COMMENT ON COLUMN sales_orders.dispatch_pickup_address IS
  'Optional dispatcher-entered pickup address. Blank uses the mapped outbound yard address.';
COMMENT ON COLUMN purchase_orders.dispatch_pickup_address IS
  'Optional dispatcher-entered pickup address. Blank uses the mapped vendor or source-yard address.';
COMMENT ON COLUMN transfer_orders.dispatch_pickup_address IS
  'Optional dispatcher-entered pickup address. Blank uses the mapped from-yard address.';
