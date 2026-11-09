-- Special requests waiting for the customer to collect get their own stage, Waiting Customer Pickup:
-- 1. Pickup at inquired yard: the linked PO has been received (local receipt or PO drop-off, or a
--    NetSuite Received/Billed status). SPREQ-000147 showed Waiting Vendor Confirmation instead.
-- 2. Customer pickup at the vendor yard: the approved PO's SCM reference is Queued (or a later
--    transport status), or the PO step was skipped. These were Dispatch Arrangement (migration 331).
-- Completion rules and special_stock_completion_evidence are unchanged; receipt uses the same
-- evidence as its yard-pickup and vendor-pickup rules. Backorder stages are unchanged.
-- No request or order data changes.
CREATE OR REPLACE VIEW special_stock_purchase_receipt AS
SELECT special.request_id,
  COALESCE(special.purchase_order_netsuite_id IS NOT NULL AND (
    (COALESCE(purchase.receipt_status,'') !~* 'partial'
      AND (purchase.receipt_status = 'received' OR completion.purchase_order_delivered_at IS NOT NULL))
    OR (purchase.netsuite_active IS DISTINCT FROM false AND
      lower(btrim(regexp_replace(COALESCE(purchase.status_text,''),'^.*: *','')))
        IN ('received','fully received','pending bill','billed','fully billed'))), false) AS received
FROM sales_special_stock_cases special
JOIN special_stock_purchase_targets target ON target.request_id = special.request_id
LEFT JOIN purchase_orders purchase ON purchase.netsuite_id = target.po_id
LEFT JOIN special_stock_completion_evidence completion ON completion.request_id = special.request_id;

CREATE OR REPLACE VIEW special_stock_workflow_stages AS
SELECT special.request_id,
  CASE
    WHEN special.close_status = 'closed' OR request.status = 'cancelled' THEN 'closed'
    WHEN special.workflow_kind = 'backorder'
      AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status='already_ordered')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id
        AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('declined','closed')) THEN 'completed'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id)
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND sales_decision NOT IN ('declined','closed')) THEN 'closed'
    WHEN completion.completed THEN 'completed'
    WHEN special.information_request->>'status' = 'pending' THEN 'pending_update'
    WHEN special.workflow_kind = 'backorder' AND special.purchase_order_netsuite_id IS NOT NULL
      THEN CASE WHEN dispatch_state.ready THEN 'dispatch_arrangement' ELSE 'confirmed' END
    WHEN special.workflow_kind = 'backorder' AND special.sales_order_netsuite_id IS NOT NULL THEN 'confirmed'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision='accepted')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('accepted','declined','closed')) THEN 'confirmed'
    WHEN special.workflow_kind = 'special' AND special.sales_order_netsuite_id IS NULL
      AND NOT special.sales_order_skipped AND (
        special.purchase_order_netsuite_id IS NOT NULL OR special.purchase_order_skipped
        OR (EXISTS (SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND removed_at IS NULL)
          AND (NOT EXISTS (SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND removed_at IS NULL
            AND sales_decision NOT IN ('accepted','declined','closed'))
            OR NOT EXISTS (SELECT 1 FROM sales_special_stock_lines WHERE request_id=special.request_id AND removed_at IS NULL
              AND sales_decision NOT IN ('declined','closed') AND (supply_status IS NULL OR sales_decision='request_update')))))
      THEN 'await_customer_confirmation'
    WHEN special.workflow_kind = 'special' AND special.purchase_order_netsuite_id IS NOT NULL
      THEN CASE
        WHEN special.fulfillment_method = 'yard_pickup' AND receipt.received THEN 'waiting_customer_pickup'
        WHEN approval.approved AND dispatch_state.ready
          THEN CASE WHEN special.fulfillment_method = 'vendor_pickup' THEN 'waiting_customer_pickup' ELSE 'dispatch_arrangement' END
        WHEN special.purchase_order_sent_to_vendor_at IS NOT NULL THEN 'waiting_vendor_confirmation' ELSE 'confirmed' END
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'confirmed'
    WHEN special.purchase_order_skipped THEN CASE WHEN special.workflow_kind = 'special' AND special.fulfillment_method = 'vendor_pickup'
      THEN 'waiting_customer_pickup' ELSE 'dispatch_arrangement' END
    WHEN special.sales_order_netsuite_id IS NOT NULL OR special.sales_order_skipped THEN 'confirmed'
    WHEN special.workflow_kind = 'special'
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line WHERE line.removed_at IS NULL AND line.request_id=special.request_id AND line.sales_decision='accepted')
      AND NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line WHERE line.removed_at IS NULL AND line.request_id=special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed')) THEN 'confirmed'
    WHEN special.line_edit_state->>'revision' = request.revision::text
      AND special.line_edit_state->>'stage' IN ('new_enquiry','await_customer_confirmation','wait_for_production','pending_update')
      AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
      AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
      THEN special.line_edit_state->>'stage'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND (line.supply_status IS NULL OR line.sales_decision = 'request_update')
        AND (special.workflow_kind = 'backorder' OR line.sales_decision NOT IN ('declined','closed'))
        AND (special.workflow_kind <> 'backorder' OR line.supply_status IS DISTINCT FROM 'already_ordered')) THEN 'await_customer_confirmation'
    ELSE 'new_enquiry'
  END AS stage
FROM sales_special_stock_cases special
JOIN sales_stock_requests request ON request.id = special.request_id
JOIN special_stock_purchase_approval approval ON approval.request_id = special.request_id
JOIN special_stock_purchase_dispatch_state dispatch_state ON dispatch_state.request_id = special.request_id
LEFT JOIN special_stock_completion_evidence completion ON completion.request_id = special.request_id
LEFT JOIN special_stock_purchase_receipt receipt ON receipt.request_id = special.request_id;
