-- PO-only materials and fees are ancillary to the request, not SO lines.
-- Existing PALLET uniqueness and material/case identity indexes are retained.
ALTER TABLE sales_special_stock_order_lines
  DROP CONSTRAINT IF EXISTS sales_special_stock_order_line_case_check;
ALTER TABLE sales_special_stock_order_lines
  ADD CONSTRAINT sales_special_stock_order_line_case_check CHECK (
    (ancillary = true AND case_line_id IS NULL
      AND (order_kind = 'sales_order' OR (order_kind = 'purchase_order' AND item_id > 0)))
    OR (ancillary = false AND case_line_id IS NOT NULL)
  );
