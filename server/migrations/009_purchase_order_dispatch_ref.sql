ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS dispatch_ref text,
  ADD COLUMN IF NOT EXISTS dispatch_ref_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_ref_updated_by text;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_dispatch_ref
  ON purchase_orders (lower(dispatch_ref))
  WHERE dispatch_ref IS NOT NULL AND dispatch_ref <> '';

UPDATE purchase_orders po
   SET dispatch_ref = s.split_po_ref,
       dispatch_ref_updated_at = COALESCE(po.dispatch_ref_updated_at, s.created_at),
       dispatch_ref_updated_by = COALESCE(po.dispatch_ref_updated_by, s.created_by)
  FROM dispatch_scm_po_splits s
 WHERE s.split_po_id = po.netsuite_id
   AND s.status = 'active'
   AND COALESCE(po.dispatch_ref, '') = '';
