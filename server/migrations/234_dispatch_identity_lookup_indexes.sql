-- Dispatch status reads run during both page loads and serialized plan updates.
-- Match their exact predicates, including every branch of the PO alias join.
-- Existing upper(btrim(...)) indexes cannot serve lower(btrim(...)) lookups.
CREATE INDEX IF NOT EXISTS idx_sales_orders_dispatch_ref_lower
  ON sales_orders (lower(btrim(tranid)));
CREATE INDEX IF NOT EXISTS idx_sales_orders_dispatch_id_text
  ON sales_orders ((netsuite_id::text));
CREATE INDEX IF NOT EXISTS idx_purchase_orders_dispatch_tranid_lower
  ON purchase_orders (lower(btrim(tranid)));
CREATE INDEX IF NOT EXISTS idx_purchase_orders_dispatch_ref_lower
  ON purchase_orders (lower(btrim(dispatch_ref)));
CREATE INDEX IF NOT EXISTS idx_purchase_orders_dispatch_id_text
  ON purchase_orders ((netsuite_id::text));
