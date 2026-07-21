ALTER TABLE scm_smart_proposals
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_status;

ALTER TABLE scm_smart_proposals
  ADD CONSTRAINT scm_smart_proposals_status CHECK (
    status IN (
      'draft', 'held', 'order_requested', 'awaiting_vendor', 'vendor_replied',
      'reviewed', 'confirmed', 'executing', 'completed', 'failed',
      'superseded', 'cancelled', 'attention'
    )
  );

ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS order_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_requested_by text,
  ADD COLUMN IF NOT EXISTS vendor_replied_at timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_replied_by text,
  ADD COLUMN IF NOT EXISTS vendor_response_status text NOT NULL DEFAULT 'awaiting',
  ADD COLUMN IF NOT EXISTS vendor_ready_date date,
  ADD COLUMN IF NOT EXISTS vendor_reference text,
  ADD COLUMN IF NOT EXISTS vendor_packing_number text,
  ADD COLUMN IF NOT EXISTS vendor_credit_status text,
  ADD COLUMN IF NOT EXISTS vendor_remarks text,
  ADD COLUMN IF NOT EXISTS vendor_response_source text NOT NULL DEFAULT 'load_grid',
  ADD COLUMN IF NOT EXISTS netsuite_purchase_order_id bigint,
  ADD COLUMN IF NOT EXISTS netsuite_purchase_order_ref text,
  ADD COLUMN IF NOT EXISTS po_execution_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS po_execution_error text;

ALTER TABLE scm_smart_proposals
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_vendor_response_status;

ALTER TABLE scm_smart_proposals
  ADD CONSTRAINT scm_smart_proposals_vendor_response_status CHECK (
    vendor_response_status IN ('awaiting', 'confirmed', 'partial', 'out_of_stock', 'production_eta', 'credit_hold', 'cancelled')
  );

ALTER TABLE scm_smart_proposal_lines
  ADD COLUMN IF NOT EXISTS is_alternative boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alternative_for_line_id bigint,
  ADD COLUMN IF NOT EXISTS added_source text NOT NULL DEFAULT 'planning',
  ADD COLUMN IF NOT EXISTS added_by text;

ALTER TABLE scm_smart_proposal_lines
  DROP CONSTRAINT IF EXISTS scm_smart_proposal_lines_added_source;

ALTER TABLE scm_smart_proposal_lines
  ADD CONSTRAINT scm_smart_proposal_lines_added_source CHECK (
    added_source IN ('planning', 'system', 'manual')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_smart_proposal_lines_alternative_for_fk'
  ) THEN
    ALTER TABLE scm_smart_proposal_lines
      ADD CONSTRAINT scm_smart_proposal_lines_alternative_for_fk
      FOREIGN KEY (alternative_for_line_id)
      REFERENCES scm_smart_proposal_lines(id)
      ON DELETE SET NULL;
  END IF;
END $$;

WITH reply_summary AS (
  SELECT l.proposal_id,
         MAX(v.responded_at) AS replied_at,
         MAX(v.responded_by) FILTER (WHERE v.responded_by IS NOT NULL) AS replied_by,
         MAX(v.ready_date) AS ready_date,
         MAX(v.vendor_reference) FILTER (WHERE NULLIF(v.vendor_reference, '') IS NOT NULL) AS vendor_reference,
         MAX(v.packing_number) FILTER (WHERE NULLIF(v.packing_number, '') IS NOT NULL) AS packing_number,
         MAX(v.credit_status) FILTER (WHERE NULLIF(v.credit_status, '') IS NOT NULL) AS credit_status,
         MAX(v.remarks) FILTER (WHERE NULLIF(v.remarks, '') IS NOT NULL) AS remarks,
         CASE
           WHEN BOOL_OR(v.response_status = 'credit_hold') THEN 'credit_hold'
           WHEN BOOL_OR(v.response_status = 'production_eta') THEN 'production_eta'
           WHEN BOOL_OR(v.response_status = 'partial') THEN 'partial'
           WHEN BOOL_OR(v.response_status = 'out_of_stock') THEN 'out_of_stock'
           WHEN BOOL_AND(v.response_status = 'confirmed') THEN 'confirmed'
           ELSE 'awaiting'
         END AS response_status,
         CASE WHEN COUNT(DISTINCT NULLIF(v.netsuite_po_reference, '')) = 1
              THEN MAX(NULLIF(v.netsuite_po_reference, '')) END AS po_reference
    FROM scm_smart_proposal_lines l
    JOIN scm_smart_vendor_responses v ON v.proposal_line_id = l.id
   GROUP BY l.proposal_id
)
UPDATE scm_smart_proposals p
   SET order_requested_at = COALESCE(p.order_requested_at, p.created_at),
       vendor_replied_at = COALESCE(p.vendor_replied_at, summary.replied_at),
       vendor_replied_by = COALESCE(p.vendor_replied_by, summary.replied_by),
       vendor_response_status = summary.response_status,
       vendor_ready_date = COALESCE(p.vendor_ready_date, summary.ready_date),
       vendor_reference = COALESCE(p.vendor_reference, summary.vendor_reference),
       vendor_packing_number = COALESCE(p.vendor_packing_number, summary.packing_number),
       vendor_credit_status = COALESCE(p.vendor_credit_status, summary.credit_status),
       vendor_remarks = COALESCE(p.vendor_remarks, summary.remarks),
       netsuite_purchase_order_ref = COALESCE(p.netsuite_purchase_order_ref, summary.po_reference),
       status = CASE
         WHEN p.status IN ('completed', 'executing', 'failed', 'superseded', 'cancelled') THEN p.status
         ELSE 'vendor_replied'
       END,
       updated_at = now()
  FROM reply_summary summary
 WHERE p.id = summary.proposal_id
   AND p.proposal_type = 'PO';

UPDATE scm_smart_proposals
   SET status = 'held',
       vendor_reply_due_at = NULL,
       updated_at = now()
 WHERE proposal_type = 'PO'
   AND status IN ('draft', 'awaiting_vendor', 'reviewed', 'attention')
   AND vendor_replied_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_vendor_reply_queue
  ON scm_smart_proposals (status, order_requested_at DESC, id DESC)
  WHERE proposal_type = 'PO';

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposal_lines_alternative_for
  ON scm_smart_proposal_lines (alternative_for_line_id)
  WHERE alternative_for_line_id IS NOT NULL;

COMMENT ON COLUMN scm_smart_proposals.netsuite_purchase_order_ref IS
  'One NetSuite or mock purchase-order reference for the whole confirmed vendor load.';

COMMENT ON COLUMN scm_smart_proposal_lines.alternative_for_line_id IS
  'Original proposal line replaced or supplemented by this vendor-approved alternative.';
