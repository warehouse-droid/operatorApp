ALTER TABLE sales_stock_requests
  ADD COLUMN IF NOT EXISTS remarks text NOT NULL DEFAULT '';

ALTER TABLE sales_stock_requests
  DROP CONSTRAINT IF EXISTS sales_stock_requests_remarks_length_check;

ALTER TABLE sales_stock_requests
  ADD CONSTRAINT sales_stock_requests_remarks_length_check CHECK (char_length(remarks) <= 2000);

COMMENT ON COLUMN sales_stock_requests.remarks IS
  'Optional Sales-entered request-level remark visible to Sales and SCM.';
