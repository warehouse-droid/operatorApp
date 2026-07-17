ALTER TABLE scm_vrma_order_lines
  ADD COLUMN IF NOT EXISTS item_description text,
  ADD COLUMN IF NOT EXISTS pallet_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS layer_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS section_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS to_plt numeric,
  ADD COLUMN IF NOT EXISTS to_lyr numeric,
  ADD COLUMN IF NOT EXISTS to_sec numeric,
  ADD COLUMN IF NOT EXISTS to_pcs numeric;
