-- Reversible Sales decisions retain the current stage until another workflow action.
ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS line_edit_state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(line_edit_state) = 'object');
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS decline_restore jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(decline_restore) = 'object');

CREATE OR REPLACE VIEW special_stock_workflow_stages AS
SELECT special.request_id,
  CASE
    WHEN special.close_status = 'closed' OR request.status = 'cancelled' THEN 'closed'
    WHEN special.operationally_complete OR
      (special.fulfillment_method = 'mbt_delivery' AND EXISTS (
        SELECT 1 FROM dispatch_order_completion_status completion
        WHERE completion.order_kind = 'SO'
          AND lower(btrim(completion.order_ref)) = lower(btrim(special.sales_order_ref)))) OR
      (special.fulfillment_method = 'yard_pickup' AND EXISTS (
        SELECT 1 FROM operator_load_records pickup
        WHERE pickup.order_id = special.sales_order_netsuite_id
          AND pickup.load_type = 'customer_pickup_load'
          AND pickup.response->>'pickupStatus' = 'loaded')) THEN 'completed'
    WHEN special.information_request->>'status' = 'pending' THEN 'pending_update'
    WHEN special.line_edit_state->>'revision' = request.revision::text
      AND special.line_edit_state->>'stage' IN ('new_enquiry','await_customer_confirmation','wait_for_production','pending_update')
      AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
      AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
      THEN special.line_edit_state->>'stage'
    WHEN special.purchase_order_netsuite_id IS NOT NULL AND NOT approval.approved THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'wait_for_production'
    WHEN (special.purchase_order_netsuite_id IS NOT NULL OR special.purchase_order_skipped)
      AND special.fulfillment_method <> 'vendor_pickup' THEN 'dispatch_arrangement'
    WHEN special.sales_order_netsuite_id IS NOT NULL OR special.sales_order_skipped THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND (line.supply_status IS NULL OR line.sales_decision = 'request_update')) THEN 'await_customer_confirmation'
    ELSE 'new_enquiry'
  END AS stage
FROM sales_special_stock_cases special
JOIN sales_stock_requests request ON request.id = special.request_id
JOIN special_stock_purchase_approval approval ON approval.request_id = special.request_id;
