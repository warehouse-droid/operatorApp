-- Additive only: existing orders keep their existing discount and rep behavior.
ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS netsuite_sales_rep_id bigint,
  ADD COLUMN IF NOT EXISTS netsuite_sales_rep_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sales_discount_mode text,
  ADD COLUMN IF NOT EXISTS vendor_discount_review jsonb NOT NULL DEFAULT '{}';
