ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS last_purchase_price numeric,
  ADD COLUMN IF NOT EXISTS purchase_unit text;

ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS parent_proposal_id bigint,
  ADD COLUMN IF NOT EXISTS vendor_resolution_kind text,
  ADD COLUMN IF NOT EXISTS price_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS pallet_item_id bigint,
  ADD COLUMN IF NOT EXISTS pallet_item_name text,
  ADD COLUMN IF NOT EXISTS pallet_unit text,
  ADD COLUMN IF NOT EXISTS pallet_purchase_unit text,
  ADD COLUMN IF NOT EXISTS pallet_last_purchase_price numeric,
  ADD COLUMN IF NOT EXISTS pallet_price_synced_at timestamptz;

ALTER TABLE scm_smart_proposal_lines
  ADD COLUMN IF NOT EXISTS vendor_decision text,
  ADD COLUMN IF NOT EXISTS last_purchase_price numeric,
  ADD COLUMN IF NOT EXISTS last_purchase_price_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_unit text;

ALTER TABLE scm_smart_proposals
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_vendor_resolution_kind_check;

ALTER TABLE scm_smart_proposals
  ADD CONSTRAINT scm_smart_proposals_vendor_resolution_kind_check CHECK (
    vendor_resolution_kind IS NULL
    OR vendor_resolution_kind IN ('netsuite_po_review', 'vendor_cancelled_history')
  );

ALTER TABLE scm_smart_proposal_lines
  DROP CONSTRAINT IF EXISTS scm_smart_proposal_lines_vendor_decision_check;

ALTER TABLE scm_smart_proposal_lines
  ADD CONSTRAINT scm_smart_proposal_lines_vendor_decision_check CHECK (
    vendor_decision IS NULL
    OR vendor_decision IN ('confirm', 'hold', 'cancel')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_smart_proposals_parent_proposal_fkey'
  ) THEN
    ALTER TABLE scm_smart_proposals
      ADD CONSTRAINT scm_smart_proposals_parent_proposal_fkey
      FOREIGN KEY (parent_proposal_id)
      REFERENCES scm_smart_proposals(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_po_review
  ON scm_smart_proposals (status, updated_at DESC, id DESC)
  WHERE proposal_type = 'PO'
    AND vendor_resolution_kind = 'netsuite_po_review';

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_parent
  ON scm_smart_proposals (parent_proposal_id, id)
  WHERE parent_proposal_id IS NOT NULL;

COMMENT ON COLUMN inventory_items.last_purchase_price IS
  'NetSuite item.lastpurchaseprice, expressed in the item purchase unit and refreshed with Item Master inventory sync.';

COMMENT ON COLUMN inventory_items.purchase_unit IS
  'NetSuite item.purchaseunit display value used to guard Last Purchase Price unit compatibility.';

COMMENT ON COLUMN scm_smart_proposals.vendor_resolution_kind IS
  'Identifies a staged NetSuite PO review child or a terminal cancelled-line history child created from a vendor reply load.';

COMMENT ON COLUMN scm_smart_proposal_lines.last_purchase_price IS
  'Immutable NetSuite Last Purchase Price snapshot reviewed before this Smart SCM line is inserted into a PO.';

COMMENT ON COLUMN scm_smart_proposal_lines.purchase_unit IS
  'NetSuite purchase unit snapshotted with Last Purchase Price; PO execution is blocked when it differs from the planning stock unit.';

COMMENT ON COLUMN scm_smart_proposal_lines.vendor_decision IS
  'UI-facing vendor decision: confirm creates a PO review line, hold stays unresolved, and cancel is retained as terminal history.';
