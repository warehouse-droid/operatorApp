ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS item_type text,
  ADD COLUMN IF NOT EXISTS item_type_text text;
