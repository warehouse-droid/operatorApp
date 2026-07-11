ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS vendor_address text;

