ALTER TABLE scm_smart_sync_state
  ADD COLUMN IF NOT EXISTS sales_source text NOT NULL DEFAULT 'workbook',
  ADD COLUMN IF NOT EXISTS sales_filename text,
  ADD COLUMN IF NOT EXISTS sales_sha256 text;

UPDATE scm_smart_sync_state
   SET sales_status = 'never',
       sales_started_at = NULL,
       sales_error = NULL,
       sales_source = CASE
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'csv') THEN 'csv'
         ELSE 'workbook'
       END,
       updated_at = now()
 WHERE sales_status = 'running';

COMMENT ON COLUMN scm_smart_sync_state.sales_source IS
  'Authoritative Smart SCM sales-history source. NetSuite history API is suspended; csv is user-uploaded raw data.';
