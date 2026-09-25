-- Add rental quotes without changing any immutable quote revision or outbox job.
ALTER TABLE field_sales_catalog DROP CONSTRAINT field_sales_catalog_company_check;
ALTER TABLE field_sales_catalog ADD CONSTRAINT field_sales_catalog_company_check CHECK(company IN ('MBBS','MBR','MBT'));
ALTER TABLE field_sales_estimates DROP CONSTRAINT field_sales_estimates_company_check;
ALTER TABLE field_sales_estimates ADD CONSTRAINT field_sales_estimates_company_check CHECK(company IN ('MBBS','MBR','MBT'));
ALTER TABLE field_sales_posting_jobs DROP CONSTRAINT field_sales_posting_jobs_company_check;
ALTER TABLE field_sales_posting_jobs ADD CONSTRAINT field_sales_posting_jobs_company_check CHECK(company IN ('MBBS','MBR','MBT'));
ALTER TABLE field_sales_settings ALTER COLUMN data SET DEFAULT '{"enabled":false,"importsEnabled":false,"postingEnabled":false,"companies":{"MBBS":{"name":"MBBS","taxBps":1300},"MBR":{"name":"MBR","taxBps":1300},"MBT":{"name":"MBT","taxBps":1300}}}'::jsonb;
UPDATE field_sales_settings SET data=jsonb_set(data,'{companies}', '{"MBR":{"name":"MBR","taxBps":1300}}'::jsonb||(data->'companies')),revision=revision+1,updated_at=now();
-- The previous reader supplied Base Price / local MBT rates. Require Trade refresh
-- or an explicitly agreed rate for future drafts; history stays untouched.
UPDATE field_sales_catalog SET unit_rate=NULL,pricing=pricing||jsonb_build_object('source','Trade price refresh required','priceLevel',CASE WHEN company='MBBS' THEN 'TRADE-A' ELSE 'TRADE' END,'tiers','[]'::jsonb),updated_at=now();
