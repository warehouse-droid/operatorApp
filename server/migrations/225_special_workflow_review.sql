ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS delivery_contact_name text,
  ADD COLUMN IF NOT EXISTS delivery_contact_phone text,
  ADD COLUMN IF NOT EXISTS pallet_total integer CHECK (pallet_total >= 0),
  ADD COLUMN IF NOT EXISTS pallet_rate numeric CHECK (pallet_rate >= 0);
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT IF EXISTS sales_special_stock_delivery_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT sales_special_stock_delivery_check CHECK (
  fulfillment_method IS DISTINCT FROM 'mbt_delivery'
  OR (NULLIF(btrim(delivery_address), '') IS NOT NULL
    AND ((delivery_window_start IS NULL AND delivery_window_end IS NULL)
      OR (delivery_window_start IS NOT NULL AND delivery_window_end IS NOT NULL AND delivery_window_end > delivery_window_start)))
);
ALTER TABLE sales_special_stock_lines
  ADD COLUMN IF NOT EXISTS reminder_due_date date,
  ADD COLUMN IF NOT EXISTS stock_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS stock_checked_by text REFERENCES operators(id) ON DELETE SET NULL;

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
    WHEN special.purchase_order_netsuite_id IS NOT NULL AND special.fulfillment_method <> 'vendor_pickup' THEN 'dispatch_arrangement'
    WHEN special.sales_order_netsuite_id IS NOT NULL THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND (line.supply_status IS NULL OR line.sales_decision = 'request_update')) THEN 'await_customer_confirmation'
    ELSE 'new_enquiry'
  END AS stage
FROM sales_special_stock_cases special
JOIN sales_stock_requests request ON request.id = special.request_id;

CREATE INDEX IF NOT EXISTS idx_special_stock_reminder
ON sales_special_stock_lines(reminder_due_date, request_id)
WHERE sales_decision = 'accepted' AND supply_status <> 'in_stock';

ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS sales_order_submission_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_order_submission_started_at timestamptz;
