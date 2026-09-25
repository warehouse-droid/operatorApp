INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES ('special_stock_request_test_skip_orders', false,
  'Testing only: allow audited Special Item SO/PO skips without creating NetSuite orders')
ON CONFLICT (flag_key) DO NOTHING;

ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS sales_order_skipped boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS purchase_order_skipped boolean NOT NULL DEFAULT false;

ALTER TABLE sales_special_stock_cases
  DROP CONSTRAINT IF EXISTS sales_special_stock_test_order_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT sales_special_stock_test_order_check CHECK (
  (NOT sales_order_skipped OR (sales_order_netsuite_id IS NULL AND purchase_order_netsuite_id IS NULL))
  AND (NOT purchase_order_skipped OR purchase_order_netsuite_id IS NULL)
  AND (NOT purchase_order_skipped OR sales_order_skipped OR sales_order_netsuite_id IS NOT NULL)
);

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
JOIN sales_stock_requests request ON request.id = special.request_id;
