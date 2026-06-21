ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS to_plt numeric,
  ADD COLUMN IF NOT EXISTS to_lyr numeric,
  ADD COLUMN IF NOT EXISTS to_sec numeric,
  ADD COLUMN IF NOT EXISTS to_pcs numeric;

ALTER TABLE cycle_count_lines
  ADD COLUMN IF NOT EXISTS counted_section_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counted_piece_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counted_total_qty numeric,
  ADD COLUMN IF NOT EXISTS variance_qty numeric,
  ADD COLUMN IF NOT EXISTS to_plt numeric,
  ADD COLUMN IF NOT EXISTS to_lyr numeric,
  ADD COLUMN IF NOT EXISTS to_sec numeric,
  ADD COLUMN IF NOT EXISTS to_pcs numeric;
