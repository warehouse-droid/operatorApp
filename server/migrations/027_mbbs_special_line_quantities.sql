ALTER TABLE sales_order_lines
  ADD COLUMN IF NOT EXISTS pack_quantity_source text NOT NULL DEFAULT 'sales_only',
  ADD COLUMN IF NOT EXISTS packed_sales_qty numeric NOT NULL DEFAULT 0;

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS pack_quantity_source text NOT NULL DEFAULT 'sales_only',
  ADD COLUMN IF NOT EXISTS received_sales_qty numeric NOT NULL DEFAULT 0;

ALTER TABLE transfer_order_lines
  ADD COLUMN IF NOT EXISTS pack_quantity_source text NOT NULL DEFAULT 'sales_only',
  ADD COLUMN IF NOT EXISTS packed_sales_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS received_sales_qty numeric NOT NULL DEFAULT 0;

UPDATE sales_order_lines
   SET pack_quantity_source = CASE
     WHEN COALESCE(to_plt, 0) > 0 OR COALESCE(to_lyr, 0) > 0
       OR COALESCE(to_sec, 0) > 0 OR COALESCE(to_pcs, 0) > 0 THEN 'item_conversion'
     WHEN COALESCE(pallet_qty, 0) > 0 OR COALESCE(layer_qty, 0) > 0
       OR COALESCE(section_qty, 0) > 0 OR COALESCE(piece_qty, 0) > 0 THEN 'netsuite_manual'
     ELSE 'sales_only'
   END;

UPDATE purchase_order_lines
   SET pack_quantity_source = CASE
     WHEN COALESCE(to_plt, 0) > 0 OR COALESCE(to_lyr, 0) > 0
       OR COALESCE(to_sec, 0) > 0 OR COALESCE(to_pcs, 0) > 0 THEN 'item_conversion'
     WHEN COALESCE(pallet_qty, 0) > 0 OR COALESCE(layer_qty, 0) > 0
       OR COALESCE(section_qty, 0) > 0 OR COALESCE(piece_qty, 0) > 0 THEN 'netsuite_manual'
     ELSE 'sales_only'
   END;

UPDATE transfer_order_lines
   SET pack_quantity_source = CASE
     WHEN COALESCE(to_plt, 0) > 0 OR COALESCE(to_lyr, 0) > 0
       OR COALESCE(to_sec, 0) > 0 OR COALESCE(to_pcs, 0) > 0 THEN 'item_conversion'
     WHEN COALESCE(pallet_qty, 0) > 0 OR COALESCE(layer_qty, 0) > 0
       OR COALESCE(section_qty, 0) > 0 OR COALESCE(piece_qty, 0) > 0 THEN 'netsuite_manual'
     ELSE 'sales_only'
   END;

ALTER TABLE sales_order_lines
  DROP CONSTRAINT IF EXISTS sales_order_lines_pack_quantity_source_check,
  ADD CONSTRAINT sales_order_lines_pack_quantity_source_check
    CHECK (pack_quantity_source IN ('netsuite_manual', 'item_conversion', 'sales_only'));

ALTER TABLE purchase_order_lines
  DROP CONSTRAINT IF EXISTS purchase_order_lines_pack_quantity_source_check,
  ADD CONSTRAINT purchase_order_lines_pack_quantity_source_check
    CHECK (pack_quantity_source IN ('netsuite_manual', 'item_conversion', 'sales_only'));

ALTER TABLE transfer_order_lines
  DROP CONSTRAINT IF EXISTS transfer_order_lines_pack_quantity_source_check,
  ADD CONSTRAINT transfer_order_lines_pack_quantity_source_check
    CHECK (pack_quantity_source IN ('netsuite_manual', 'item_conversion', 'sales_only'));

COMMENT ON COLUMN sales_order_lines.pack_quantity_source IS
  'Origin of PLT/LYR/SEC/PCS quantities: NetSuite manual input, item conversion, or sales quantity only.';
COMMENT ON COLUMN sales_order_lines.packed_sales_qty IS
  'Explicit packed sales-unit quantity for manual-pack lines without item conversions.';
COMMENT ON COLUMN purchase_order_lines.received_sales_qty IS
  'Explicit received sales-unit quantity for manual-pack lines without item conversions.';
