-- Dispatch plan bootstrap resolves every operational order reference against
-- NetSuite order families.  Keep those joins indexable as plan history grows;
-- function-wrapped OR joins previously rescanned the full order tables once
-- per reference during every date switch.

CREATE INDEX IF NOT EXISTS idx_sales_orders_normalized_tranid
  ON sales_orders (upper(btrim(tranid)));

CREATE INDEX IF NOT EXISTS idx_purchase_orders_normalized_tranid
  ON purchase_orders (upper(btrim(tranid)));

CREATE INDEX IF NOT EXISTS idx_purchase_orders_normalized_dispatch_ref
  ON purchase_orders (upper(btrim(dispatch_ref)));

CREATE INDEX IF NOT EXISTS idx_transfer_orders_normalized_tranid
  ON transfer_orders (upper(btrim(tranid)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_so_splits_source_ref_normalized
  ON dispatch_scm_so_splits (upper(btrim(source_so_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_so_splits_split_ref_normalized
  ON dispatch_scm_so_splits (upper(btrim(split_so_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_so_splits_split_id
  ON dispatch_scm_so_splits (split_so_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_po_splits_source_ref_normalized
  ON dispatch_scm_po_splits (upper(btrim(source_po_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_po_splits_split_ref_normalized
  ON dispatch_scm_po_splits (upper(btrim(split_po_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_po_splits_split_id
  ON dispatch_scm_po_splits (split_po_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_to_splits_source_ref_normalized
  ON dispatch_scm_to_splits (upper(btrim(source_to_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_to_splits_split_ref_normalized
  ON dispatch_scm_to_splits (upper(btrim(split_to_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_to_splits_split_id
  ON dispatch_scm_to_splits (split_to_id);
