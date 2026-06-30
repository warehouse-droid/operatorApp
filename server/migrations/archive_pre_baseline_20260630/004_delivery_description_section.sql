ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS item_description text,
  ADD COLUMN IF NOT EXISTS section_qty numeric,
  ADD COLUMN IF NOT EXISTS packed_section_qty numeric NOT NULL DEFAULT 0;
