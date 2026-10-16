-- Preserve removed request lines and their issued-order/audit references.
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS removed_by text REFERENCES operators(id) ON DELETE SET NULL;
ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS local_adjusted_at timestamptz;

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
    WHEN special.workflow_kind = 'backorder' AND special.sales_order_netsuite_id IS NOT NULL THEN 'completed'
    WHEN completion.completed THEN 'completed'
    WHEN special.information_request->>'status' = 'pending' THEN 'pending_update'
    WHEN special.workflow_kind = 'backorder' AND special.purchase_order_netsuite_id IS NOT NULL THEN 'dispatch_arrangement'
    WHEN special.workflow_kind = 'backorder' AND EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision='accepted')
      AND NOT EXISTS(SELECT 1 FROM sales_special_stock_lines WHERE removed_at IS NULL AND request_id=special.request_id AND supply_status IS DISTINCT FROM 'already_ordered' AND sales_decision NOT IN ('accepted','declined','closed')) THEN 'confirmed'
    WHEN special.workflow_kind = 'special' AND special.purchase_order_netsuite_id IS NOT NULL AND NOT approval.approved THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.removed_at IS NULL AND line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'confirmed'
    WHEN (special.purchase_order_netsuite_id IS NOT NULL OR special.purchase_order_skipped)
      AND (special.workflow_kind <> 'backorder' OR special.sales_order_netsuite_id IS NOT NULL)
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
LEFT JOIN special_stock_completion_evidence completion ON completion.request_id = special.request_id;
