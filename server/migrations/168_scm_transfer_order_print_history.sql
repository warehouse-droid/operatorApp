UPDATE scm_print_jobs job
   SET source_order_id = COALESCE(job.source_order_id, proposal.netsuite_transfer_order_id),
       source_order_ref = COALESCE(NULLIF(job.source_order_ref, ''), NULLIF(proposal.netsuite_transfer_order_ref, '')),
       line_location_id = COALESCE(job.line_location_id, proposal.source_location_id)
 FROM scm_smart_proposals proposal
 WHERE proposal.id = job.proposal_id
   AND proposal.proposal_type = 'TO'
   AND job.document_type IN ('picking_ticket', 'transfer_dependency_picking_ticket')
   AND (
     job.source_order_id IS NULL
     OR NULLIF(job.source_order_ref, '') IS NULL
     OR job.line_location_id IS NULL
   );

CREATE INDEX IF NOT EXISTS idx_scm_print_jobs_transfer_order_history_id
  ON scm_print_jobs (source_order_id, queued_at DESC, id DESC)
  WHERE document_type IN ('picking_ticket', 'transfer_dependency_picking_ticket');

CREATE INDEX IF NOT EXISTS idx_scm_print_jobs_transfer_order_history_ref
  ON scm_print_jobs (lower(source_order_ref), queued_at DESC, id DESC)
  WHERE document_type IN ('picking_ticket', 'transfer_dependency_picking_ticket')
    AND source_order_ref IS NOT NULL;

COMMENT ON COLUMN scm_print_jobs.source_order_ref IS
  'NetSuite transaction reference retained for immutable SO/TO print history across Sales, Smart SCM, Auto Transfer, Stock Requests, and dedicated printing pages.';
