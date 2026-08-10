ALTER TABLE dispatch_scm_po_splits
  DROP CONSTRAINT IF EXISTS dispatch_scm_po_splits_split_po_ref_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_scm_po_splits_active_ref
  ON dispatch_scm_po_splits (lower(split_po_ref))
  WHERE status = 'active';
