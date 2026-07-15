ALTER TABLE dispatch_scm_po_split_lines
  ADD COLUMN IF NOT EXISTS requested_pallet_qty numeric,
  ADD COLUMN IF NOT EXISTS requested_layer_qty numeric,
  ADD COLUMN IF NOT EXISTS requested_section_qty numeric,
  ADD COLUMN IF NOT EXISTS requested_piece_qty numeric,
  ADD COLUMN IF NOT EXISTS requested_sales_qty numeric;

UPDATE dispatch_scm_po_split_lines
   SET requested_pallet_qty = COALESCE(requested_pallet_qty, pallet_qty, 0),
       requested_layer_qty = COALESCE(requested_layer_qty, layer_qty, 0),
       requested_section_qty = COALESCE(requested_section_qty, section_qty, 0),
       requested_piece_qty = COALESCE(requested_piece_qty, piece_qty, 0),
       requested_sales_qty = COALESCE(requested_sales_qty, sales_qty, 0);

ALTER TABLE dispatch_scm_po_split_lines
  ALTER COLUMN requested_pallet_qty SET DEFAULT 0,
  ALTER COLUMN requested_pallet_qty SET NOT NULL,
  ALTER COLUMN requested_layer_qty SET DEFAULT 0,
  ALTER COLUMN requested_layer_qty SET NOT NULL,
  ALTER COLUMN requested_section_qty SET DEFAULT 0,
  ALTER COLUMN requested_section_qty SET NOT NULL,
  ALTER COLUMN requested_piece_qty SET DEFAULT 0,
  ALTER COLUMN requested_piece_qty SET NOT NULL,
  ALTER COLUMN requested_sales_qty SET DEFAULT 0,
  ALTER COLUMN requested_sales_qty SET NOT NULL;

COMMENT ON COLUMN dispatch_scm_po_split_lines.requested_sales_qty IS
  'Original SCM-requested split quantity. Current split quantities may be capped by later NetSuite PO quantity amendments and restored if capacity returns.';
