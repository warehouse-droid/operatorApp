ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS fulfillment_change jsonb NOT NULL DEFAULT '{}';

CREATE OR REPLACE VIEW special_stock_purchase_approval AS
WITH state AS (
 SELECT special.request_id, special.purchase_order_netsuite_id,
   COALESCE(purchase.netsuite_active,true) AS active,
   COALESCE(NULLIF(purchase.status,''),'') AS code,
   COALESCE(NULLIF(purchase.status_text,''),NULLIF(purchase.status,''),special.purchase_order_status,'') AS status_text
 FROM sales_special_stock_cases special
 LEFT JOIN purchase_orders purchase ON purchase.netsuite_id=special.purchase_order_netsuite_id
), normalized AS (
 SELECT *, lower(regexp_replace(status_text,'^.*: *','')) AS label FROM state
)
SELECT request_id, status_text,
 purchase_order_netsuite_id IS NOT NULL AND active AND
   CASE WHEN code IN ('A','C','H') THEN false
     WHEN code IN ('B','D','E','F','G') THEN true
     ELSE label IN ('pending receipt','partially received','pending billing','pending bill','fully billed','pending billing/partially received','pending bill/partially received') END AS approved,
 purchase_order_netsuite_id IS NOT NULL AND active AND
   (code='A' OR (code NOT IN ('B','C','D','E','F','G','H') AND label IN ('pending approval','pending supervisor approval'))) AS pending
FROM normalized;

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
    WHEN special.purchase_order_netsuite_id IS NOT NULL AND NOT approval.approved THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND line.supply_status IS DISTINCT FROM 'in_stock') THEN 'wait_for_production'
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
