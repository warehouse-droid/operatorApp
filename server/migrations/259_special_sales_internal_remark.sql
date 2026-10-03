ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS sales_internal_remark text NOT NULL DEFAULT '';

ALTER TABLE sales_special_stock_events
  DROP CONSTRAINT IF EXISTS sales_special_stock_event_audience_check;
ALTER TABLE sales_special_stock_events
  ADD CONSTRAINT sales_special_stock_event_audience_check
  CHECK (audience IN ('all', 'sales_scm', 'scm', 'sales'));

COMMENT ON COLUMN sales_special_stock_cases.sales_internal_remark IS
  'Sales-only request remark. Excluded from SCM, Dispatch and customer/order documents.';
