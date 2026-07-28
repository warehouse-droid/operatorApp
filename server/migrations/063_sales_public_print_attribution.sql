ALTER TABLE scm_print_jobs
  ADD COLUMN IF NOT EXISTS requested_company_name text,
  ADD COLUMN IF NOT EXISTS requested_ip_address text;

COMMENT ON COLUMN scm_print_jobs.requested_company_name IS
  'Company name supplied by the Sales user when a Sales Order picking ticket is queued.';

COMMENT ON COLUMN scm_print_jobs.requested_ip_address IS
  'Server-observed client IP address for the Sales Order picking-ticket request.';

CREATE INDEX IF NOT EXISTS idx_scm_print_jobs_requested_company
  ON scm_print_jobs (lower(requested_company_name)) WHERE requested_company_name IS NOT NULL;
