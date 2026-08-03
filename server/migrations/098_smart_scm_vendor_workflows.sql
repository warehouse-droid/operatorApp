CREATE TABLE IF NOT EXISTS scm_smart_vendor_workflows (
  id bigserial PRIMARY KEY,
  workflow_key text NOT NULL UNIQUE,
  workflow_kind text NOT NULL DEFAULT 'regular_po',
  source_proposal_id bigint NOT NULL REFERENCES scm_smart_proposals(id) ON DELETE CASCADE,
  review_proposal_id bigint REFERENCES scm_smart_proposals(id) ON DELETE SET NULL,
  source_purchase_order_id bigint,
  source_purchase_order_ref text,
  workflow_status text NOT NULL DEFAULT 'order_requested',
  email_subject text NOT NULL DEFAULT '',
  email_intro text NOT NULL DEFAULT '',
  email_closing text NOT NULL DEFAULT '',
  vendor_code_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_updated_at timestamptz,
  email_updated_by text,
  netsuite_purchase_order_id bigint,
  netsuite_purchase_order_ref text,
  split_id bigint,
  split_purchase_order_id bigint,
  split_purchase_order_ref text,
  archived_at timestamptz,
  archived_by text,
  archive_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_vendor_workflows_kind CHECK (
    workflow_kind IN ('regular_po', 'blanket_po')
  ),
  CONSTRAINT scm_smart_vendor_workflows_status CHECK (
    workflow_status IN (
      'order_requested', 'vendor_replied', 'po_pending', 'po_creating',
      'po_created', 'split_pending', 'split_created', 'attention', 'cancelled'
    )
  ),
  CONSTRAINT scm_smart_vendor_workflows_vendor_codes_object CHECK (
    jsonb_typeof(vendor_code_overrides) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_smart_vendor_workflows_source
  ON scm_smart_vendor_workflows (source_proposal_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_smart_vendor_workflows_review
  ON scm_smart_vendor_workflows (review_proposal_id)
  WHERE review_proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scm_smart_vendor_workflows_queue
  ON scm_smart_vendor_workflows (archived_at, workflow_status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scm_smart_vendor_workflows_purchase_order
  ON scm_smart_vendor_workflows (netsuite_purchase_order_id)
  WHERE netsuite_purchase_order_id IS NOT NULL;

WITH latest_review AS (
  SELECT DISTINCT ON (parent_proposal_id)
         id,
         parent_proposal_id,
         status,
         netsuite_purchase_order_id,
         netsuite_purchase_order_ref,
         updated_at
    FROM scm_smart_proposals
   WHERE proposal_type = 'PO'
     AND vendor_resolution_kind = 'netsuite_po_review'
     AND parent_proposal_id IS NOT NULL
   ORDER BY parent_proposal_id, id DESC
), source_rows AS (
  SELECT source.id AS source_proposal_id,
         source.proposal_origin,
         source.blanket_source_po_id,
         source.blanket_source_po_ref,
         source.status AS source_status,
         source.order_requested_at,
         source.created_at,
         review.id AS review_proposal_id,
         review.status AS review_status,
         review.netsuite_purchase_order_id,
         review.netsuite_purchase_order_ref,
         review.updated_at AS review_updated_at
    FROM scm_smart_proposals source
    LEFT JOIN latest_review review ON review.parent_proposal_id = source.id
   WHERE source.proposal_type = 'PO'
     AND source.vendor_resolution_kind IS NULL
     AND (source.order_requested_at IS NOT NULL OR review.id IS NOT NULL)
)
INSERT INTO scm_smart_vendor_workflows (
  workflow_key,
  workflow_kind,
  source_proposal_id,
  review_proposal_id,
  source_purchase_order_id,
  source_purchase_order_ref,
  workflow_status,
  netsuite_purchase_order_id,
  netsuite_purchase_order_ref,
  archived_at,
  archived_by,
  archive_reason,
  created_at,
  updated_at
)
SELECT CASE WHEN proposal_origin = 'blanket'
              THEN 'blanket-proposal:' || source_proposal_id
              ELSE 'proposal:' || source_proposal_id
       END,
       CASE WHEN proposal_origin = 'blanket' THEN 'blanket_po' ELSE 'regular_po' END,
       source_proposal_id,
       review_proposal_id,
       blanket_source_po_id,
       blanket_source_po_ref,
       CASE
         WHEN proposal_origin = 'blanket' AND source_status IN ('completed', 'cancelled')
           THEN CASE WHEN source_status = 'completed' THEN 'split_created' ELSE 'cancelled' END
         WHEN review_status = 'completed' THEN 'po_created'
         WHEN review_status = 'executing' THEN 'po_creating'
         WHEN review_status IN ('failed', 'attention') THEN 'attention'
         WHEN review_status = 'cancelled' THEN 'cancelled'
         WHEN review_proposal_id IS NOT NULL THEN 'po_pending'
         WHEN source_status = 'vendor_replied' THEN 'vendor_replied'
         WHEN source_status = 'cancelled' THEN 'cancelled'
         ELSE 'order_requested'
       END,
       netsuite_purchase_order_id,
       netsuite_purchase_order_ref,
       CASE
         WHEN review_status = 'completed' THEN COALESCE(review_updated_at, now())
         WHEN proposal_origin = 'blanket' AND source_status IN ('completed', 'cancelled') THEN now()
         ELSE NULL
       END,
       CASE
         WHEN review_status = 'completed'
           OR proposal_origin = 'blanket' AND source_status IN ('completed', 'cancelled')
         THEN 'migration-098'
         ELSE NULL
       END,
       CASE
         WHEN review_status = 'completed' THEN 'completed_backfill'
         WHEN proposal_origin = 'blanket' AND source_status IN ('completed', 'cancelled') THEN 'blanket_terminal'
         ELSE NULL
       END,
       COALESCE(order_requested_at, created_at, now()),
       COALESCE(review_updated_at, order_requested_at, created_at, now())
  FROM source_rows
ON CONFLICT (source_proposal_id) DO NOTHING;

COMMENT ON TABLE scm_smart_vendor_workflows IS
  'Stable Vendor Replies workflow identity spanning source proposal, vendor correspondence, PO review/creation, and reversible history archival.';

COMMENT ON COLUMN scm_smart_vendor_workflows.archived_at IS
  'Hides a regular completed PO from Vendor Replies and places it in application PO history; clearing it reverses that move.';
