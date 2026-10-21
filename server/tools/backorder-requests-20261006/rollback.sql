-- Additive Backorder rollback is allowed only before any Backorder has been saved.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_special_stock_cases WHERE workflow_kind='backorder') THEN
    RAISE EXCEPTION 'Rollback refused: retain the additive schema while Backorder records exist.';
  END IF;
END $$;
DROP TRIGGER backorder_no_order_drafts ON sales_special_stock_order_lines;
DROP TRIGGER backorder_no_stock_lines ON sales_stock_request_lines;
DROP TRIGGER backorder_no_transfer ON sales_stock_transfers;
DROP FUNCTION prevent_backorder_generated_lines();
DROP TRIGGER backorder_material ON sales_special_stock_lines;
DROP FUNCTION enforce_backorder_material();
DROP TRIGGER backorder_parent ON sales_stock_requests;
DROP FUNCTION preserve_backorder_parent();
DROP TRIGGER stock_case_profile ON sales_special_stock_cases;
DROP FUNCTION enforce_stock_case_profile();
DROP INDEX idx_regular_backorder_profile;
DROP INDEX idx_sales_special_stock_so_owner;
DROP INDEX idx_sales_special_stock_po_owner;
CREATE UNIQUE INDEX idx_sales_special_stock_so_owner ON sales_special_stock_cases(sales_order_netsuite_id) WHERE sales_order_netsuite_id IS NOT NULL;
CREATE UNIQUE INDEX idx_sales_special_stock_po_owner ON sales_special_stock_cases(purchase_order_netsuite_id) WHERE purchase_order_netsuite_id IS NOT NULL;
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT backorder_manual_orders_check;
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT sales_special_stock_customer_name_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT sales_special_stock_customer_name_check CHECK(NULLIF(btrim(customer_name),'') IS NOT NULL);
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

CREATE OR REPLACE FUNCTION preserve_special_original_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE editable boolean;
BEGIN
  IF OLD.original_unit_rate IS NOT NULL AND (
    NEW.original_unit_rate IS DISTINCT FROM OLD.original_unit_rate
    OR NEW.original_rate_uom IS DISTINCT FROM OLD.original_rate_uom
    OR NEW.quoted_discount_percent IS DISTINCT FROM OLD.quoted_discount_percent
  ) THEN
    IF NEW.original_unit_rate IS NOT DISTINCT FROM OLD.original_unit_rate
      AND NEW.quoted_discount_percent IS NOT DISTINCT FROM OLD.quoted_discount_percent
      AND NEW.request_id = OLD.request_id
      AND current_setting('mbbs.special_adjustment_request', true) = OLD.request_id::text
      AND EXISTS (SELECT 1 FROM sales_special_stock_cases special,
        jsonb_array_elements(COALESCE(special.quantity_review->'lines','[]'::jsonb)) change
        WHERE special.request_id=OLD.request_id AND special.close_status='active'
          AND special.quantity_review->>'status'='applying'
          AND special.quantity_review->>'mode'='issued'
          AND change->>'caseLineId'=OLD.id::text
          AND change->'toFields'->>'uom'=NEW.original_rate_uom) THEN
      RETURN NEW;
    END IF;
    IF current_setting('mbbs.special_case_edit_request', true) IS DISTINCT FROM OLD.request_id::text
      OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
      RAISE EXCEPTION 'The original Special Item rate is immutable outside the Sales case editor.' USING ERRCODE = '23514';
    END IF;
    SELECT true INTO editable FROM sales_stock_requests request
      JOIN sales_special_stock_cases special ON special.request_id = request.id
      WHERE request.id = OLD.request_id AND request.status <> 'cancelled'
        AND special.close_status = 'active' AND NOT special.operationally_complete
        AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
        AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
        AND special.sales_order_submission_started_at IS NULL AND special.purchase_order_submission_started_at IS NULL
        AND NOT special.attention
        AND COALESCE(special.sales_order_operation_status, '') NOT IN ('creating', 'attention')
        AND COALESCE(special.purchase_order_operation_status, '') NOT IN ('creating', 'attention')
        AND COALESCE(special.quantity_review->>'status', '') NOT IN ('pending', 'applying', 'attention')
        AND COALESCE(special.fulfillment_change->>'status', '') NOT IN ('pending', 'applying', 'attention')
      FOR UPDATE OF request, special;
    IF editable IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Special Item rates cannot be changed after order creation or while this case is locked.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE sales_special_stock_cases DROP COLUMN workflow_kind;
ALTER TABLE sales_special_stock_lines DROP COLUMN regular_item_id, DROP COLUMN regular_item_code;
