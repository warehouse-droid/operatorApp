ALTER TABLE sales_special_stock_order_lines
  DROP CONSTRAINT sales_special_stock_order_line_case_check;
ALTER TABLE sales_special_stock_order_lines
  ADD CONSTRAINT sales_special_stock_order_line_case_check CHECK (
    (ancillary = true AND case_line_id IS NULL
      AND (order_kind = 'sales_order' OR (order_kind = 'purchase_order' AND item_id = 1784)))
    OR (ancillary = false AND case_line_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_special_purchase_pallet
  ON sales_special_stock_order_lines (request_id)
  WHERE order_kind = 'purchase_order' AND item_id = 1784;
