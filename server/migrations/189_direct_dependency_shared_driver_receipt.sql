-- One completed customer stop can settle multiple direct-to-customer transfer
-- dependencies. The receipt ledger is uniquely keyed by
-- (dependency_id, driver_job_id); this column is only a lookup/evidence link.
DROP INDEX IF EXISTS idx_order_dependencies_direct_receipt_job;

CREATE INDEX idx_order_dependencies_direct_receipt_job
  ON order_dependencies (direct_receipt_job_id)
  WHERE direct_receipt_job_id IS NOT NULL;
