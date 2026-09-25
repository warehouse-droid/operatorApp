-- Keep the existing canonical foreign key. MBBS accounts can be selected from
-- the complete active NetSuite snapshot without inserting synthetic master data.
ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS directory_customer_id bigint;
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT IF EXISTS special_directory_customer_id_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT special_directory_customer_id_check
  CHECK (directory_customer_id IS NULL OR (directory_customer_id > 0 AND canonical_customer_id IS NULL));
COMMENT ON COLUMN sales_special_stock_cases.directory_customer_id IS
  'NetSuite customer ID validated from the active full customer directory. No FK to the replaceable snapshot; canonical_customer_id remains for canonical-master accounts.';
