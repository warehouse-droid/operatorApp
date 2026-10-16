-- Special requests may reference the same existing SO or PO, as Backorders do.
-- Keep operation IDs unique and retain indexed order lookups for reconciliation.
DROP INDEX idx_sales_special_stock_so_owner;
DROP INDEX idx_sales_special_stock_po_owner;

CREATE INDEX idx_sales_special_stock_so_owner
  ON sales_special_stock_cases (sales_order_netsuite_id)
  WHERE sales_order_netsuite_id IS NOT NULL;

CREATE INDEX idx_sales_special_stock_po_owner
  ON sales_special_stock_cases (purchase_order_netsuite_id)
  WHERE purchase_order_netsuite_id IS NOT NULL;

COMMENT ON TABLE sales_special_stock_cases IS
  'One-vendor, multi-line Special Item requests with shareable Sales Order and Purchase Order references.';
