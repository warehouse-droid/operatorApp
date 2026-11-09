-- SCM can add PO-only items (vendor fees such as a split fee, or other items) after the PO
-- exists. These reuse the PO-only lines from migration 322: ancillary purchase_order rows in
-- sales_special_stock_order_lines. They are never SO lines and need no Sales decision.
-- po_sync_status is set only for items added after the PO existed:
--   pending   - being appended to the NetSuite PO (po_sync_plan holds the verified baseline/target)
--   synced    - appended to the NetSuite PO and verified
--   attention - the NetSuite update failed; SCM retries it or keeps the item as a record only
--   local     - recorded for SCM only; the NetSuite PO is unchanged (the PO was not created by
--               this application for the request, or the PO step was skipped)
-- Items sent with the PO at creation keep po_sync_status NULL.
ALTER TABLE sales_special_stock_order_lines
  ADD COLUMN IF NOT EXISTS po_sync_status text,
  ADD COLUMN IF NOT EXISTS po_sync_error text,
  ADD COLUMN IF NOT EXISTS po_sync_plan jsonb,
  ADD COLUMN IF NOT EXISTS added_by text,
  ADD COLUMN IF NOT EXISTS added_at timestamptz;

ALTER TABLE sales_special_stock_order_lines
  DROP CONSTRAINT IF EXISTS sales_special_stock_order_line_po_sync_check;
ALTER TABLE sales_special_stock_order_lines
  ADD CONSTRAINT sales_special_stock_order_line_po_sync_check CHECK (
    po_sync_status IS NULL
    OR (po_sync_status IN ('pending', 'synced', 'attention', 'local')
      AND ancillary = true AND order_kind = 'purchase_order' AND added_at IS NOT NULL)
  );

-- The PO is independent of the reviewed draft once created: a NetSuite PO that differs from it
-- (edited description, quantity or UOM, or a line added in NetSuite) no longer needs attention.
-- Clear the existing PO coverage attention; Sales Order checks and order operations are unchanged.
UPDATE sales_special_stock_cases
   SET attention = false, attention_reason = NULL, updated_at = now()
 WHERE attention = true
   AND (attention_reason LIKE 'Purchase Order does not contain the exact reviewed item, quantity, UOM, and description for %'
     OR attention_reason ~ '^Purchase Order has [0-9]+ unreviewed item line\(s\)\.')
   AND sales_order_operation_status <> 'attention'
   AND purchase_order_operation_status <> 'attention';
