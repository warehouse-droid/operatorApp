-- Make the clarified SCM -> Sales -> SCM responsibility sequence durable.
-- A Purchase Order action is forbidden until every accepted line has a
-- second SCM response recorded after the Sales Order is linked.

ALTER TABLE sales_special_stock_lines
  ADD COLUMN IF NOT EXISTS po_ready boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS po_ready_by text REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS po_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS po_ready_response_revision integer;

-- Preserve any already-linked cases from migration 176. Their remote PO is
-- stronger evidence than the newly introduced readiness marker.
UPDATE sales_special_stock_lines line
   SET purchase_uom = COALESCE(NULLIF(btrim(line.purchase_uom), ''), line.sales_uom),
       purchase_quantity = COALESCE(line.purchase_quantity, line.sales_quantity),
       po_ready = true,
       po_ready_by = line.responded_by,
       po_ready_at = COALESCE(line.responded_at, line.updated_at, now()),
       po_ready_response_revision = GREATEST(line.response_revision, 1)
  FROM sales_special_stock_cases special
 WHERE special.request_id = line.request_id
   AND special.purchase_order_netsuite_id IS NOT NULL
   AND line.sales_decision = 'accepted'
   AND line.resolved_item_id IS NOT NULL
   AND line.sales_quantity IS NOT NULL
   AND NULLIF(btrim(line.sales_uom), '') IS NOT NULL
   AND line.po_ready = false;

ALTER TABLE sales_special_stock_lines
  DROP CONSTRAINT IF EXISTS sales_special_stock_line_po_ready_check;

ALTER TABLE sales_special_stock_lines
  ADD CONSTRAINT sales_special_stock_line_po_ready_check CHECK (
    po_ready = false
    OR (
      sales_decision = 'accepted'
      AND resolved_item_id IS NOT NULL
      AND sales_quantity IS NOT NULL
      AND purchase_quantity IS NOT NULL
      AND NULLIF(btrim(sales_uom), '') IS NOT NULL
      AND NULLIF(btrim(purchase_uom), '') IS NOT NULL
      AND po_ready_at IS NOT NULL
      AND po_ready_response_revision IS NOT NULL
      AND po_ready_response_revision > 0
    )
  );

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_po_readiness
  ON sales_special_stock_lines (request_id, po_ready)
  WHERE sales_decision = 'accepted';

COMMENT ON COLUMN sales_special_stock_lines.po_ready IS
  'True only after SCM completes its post-SO second response for this accepted line.';
