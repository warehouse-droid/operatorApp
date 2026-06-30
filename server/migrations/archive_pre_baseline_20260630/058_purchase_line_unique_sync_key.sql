CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_order_lines_order_line_unique
  ON purchase_order_lines (purchase_order_id, line_id)
  WHERE line_id IS NOT NULL;
