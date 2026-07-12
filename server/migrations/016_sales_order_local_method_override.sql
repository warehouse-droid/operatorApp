ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS netsuite_sales_order_type text,
  ADD COLUMN IF NOT EXISTS sales_order_type_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sales_order_type_updated_by text,
  ADD COLUMN IF NOT EXISTS sales_order_type_updated_at timestamptz;

UPDATE sales_orders
   SET netsuite_sales_order_type = sales_order_type
 WHERE netsuite_sales_order_type IS NULL;
