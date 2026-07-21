ALTER TABLE scm_print_jobs
  ADD COLUMN IF NOT EXISTS source_order_id bigint,
  ADD COLUMN IF NOT EXISTS source_order_ref text,
  ADD COLUMN IF NOT EXISTS line_location_id bigint,
  ADD COLUMN IF NOT EXISTS queued_by_operator_id text REFERENCES operators(id) ON DELETE SET NULL;

WITH sales_audit AS (
  SELECT DISTINCT ON ((a.details->>'printJobId')::bigint)
         (a.details->>'printJobId')::bigint AS print_job_id,
         a.order_id,
         NULLIF(a.details->>'orderRef', '') AS order_ref,
         COALESCE(
           NULLIF(a.details->>'lineLocationId', '')::bigint,
           NULLIF(a.details->>'printerLocationId', '')::bigint
         ) AS line_location_id,
         a.actor_operator_id
    FROM delivery_audit_log a
   WHERE a.action = 'sales.sales_order_picking_ticket.queued'
     AND COALESCE(a.details->>'printJobId', '') ~ '^[0-9]+$'
   ORDER BY (a.details->>'printJobId')::bigint, a.created_at DESC, a.id DESC
)
UPDATE scm_print_jobs job
   SET source_order_id = COALESCE(job.source_order_id, audit.order_id),
       source_order_ref = COALESCE(job.source_order_ref, audit.order_ref),
       line_location_id = COALESCE(job.line_location_id, audit.line_location_id),
       queued_by_operator_id = COALESCE(job.queued_by_operator_id, audit.actor_operator_id)
  FROM sales_audit audit
 WHERE job.id = audit.print_job_id
   AND job.document_type = 'sales_order_picking_ticket';

CREATE INDEX IF NOT EXISTS idx_scm_print_jobs_sales_order_history
  ON scm_print_jobs (source_order_id, queued_at DESC, id DESC)
  WHERE document_type = 'sales_order_picking_ticket';

COMMENT ON COLUMN scm_print_jobs.source_order_id IS
  'NetSuite transaction internal ID for operator-visible print history.';
COMMENT ON COLUMN scm_print_jobs.line_location_id IS
  'Exact NetSuite order-line location rendered into this immutable ticket snapshot.';
COMMENT ON COLUMN scm_print_jobs.queued_by_operator_id IS
  'Application account that requested this print snapshot.';
