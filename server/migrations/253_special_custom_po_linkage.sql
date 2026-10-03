ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS purchase_order_custom_linkage boolean NOT NULL DEFAULT false;
