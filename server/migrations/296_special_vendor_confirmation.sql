-- A sent acknowledgement belongs to the linked PO; retain actor/time for audit and retries.
ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS purchase_order_sent_to_vendor_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_order_sent_to_vendor_by text REFERENCES operators(id) ON DELETE SET NULL;

-- Customer confirmation requires an SO. Vendor waiting ends at the existing dispatch handoff.
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
      THEN CASE WHEN approval.approved AND dispatch_state.ready AND special.fulfillment_method <> 'vendor_pickup'
        THEN 'dispatch_arrangement' WHEN special.purchase_order_sent_to_vendor_at IS NOT NULL
        THEN 'waiting_vendor_confirmation' ELSE 'confirmed' END
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'confirmed'
    WHEN special.purchase_order_skipped
      AND special.fulfillment_method <> 'vendor_pickup' THEN 'dispatch_arrangement'
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
LEFT JOIN special_stock_completion_evidence completion ON completion.request_id = special.request_id;
