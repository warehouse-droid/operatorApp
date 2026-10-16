-- Backorder is a Regular request using the shared case workflow. Existing
-- Special cases retain their defaults and exclusive order ownership.
ALTER TABLE sales_special_stock_cases ADD COLUMN workflow_kind text NOT NULL DEFAULT 'special'
  CHECK (workflow_kind IN ('special','backorder'));
ALTER TABLE sales_special_stock_lines ADD COLUMN regular_item_id bigint REFERENCES inventory_items(item_id) ON DELETE RESTRICT;
ALTER TABLE sales_special_stock_lines ADD COLUMN regular_item_code text;
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT sales_special_stock_customer_name_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT sales_special_stock_customer_name_check
  CHECK (workflow_kind='backorder' OR NULLIF(btrim(customer_name),'') IS NOT NULL);
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT backorder_manual_orders_check CHECK (workflow_kind<>'backorder' OR (
  NOT sales_order_skipped AND NOT purchase_order_skipped AND pallet_total IS NULL AND pallet_rate IS NULL AND delivery_fee_rate IS NULL
  AND (sales_order_netsuite_id IS NULL OR sales_order_source='manual_link')
  AND (purchase_order_netsuite_id IS NULL OR purchase_order_custom_linkage)
  AND (NOT operationally_complete OR (sales_order_netsuite_id IS NOT NULL AND purchase_order_netsuite_id IS NOT NULL))));
DROP INDEX idx_sales_special_stock_so_owner;
DROP INDEX idx_sales_special_stock_po_owner;
CREATE UNIQUE INDEX idx_sales_special_stock_so_owner ON sales_special_stock_cases(sales_order_netsuite_id)
  WHERE sales_order_netsuite_id IS NOT NULL AND workflow_kind='special';
CREATE UNIQUE INDEX idx_sales_special_stock_po_owner ON sales_special_stock_cases(purchase_order_netsuite_id)
  WHERE purchase_order_netsuite_id IS NOT NULL AND workflow_kind='special';
CREATE INDEX idx_regular_backorder_profile ON sales_stock_requests ((regular_details->>'deliveryMethod'),updated_at DESC)
  WHERE request_type='regular' AND regular_details->>'deliveryMethod'='backorder';

CREATE FUNCTION enforce_stock_case_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent sales_stock_requests%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.workflow_kind IS DISTINCT FROM OLD.workflow_kind OR NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
    RAISE EXCEPTION 'A case workflow identity cannot change.' USING ERRCODE='23514';
  END IF;
  SELECT * INTO parent FROM sales_stock_requests WHERE id=NEW.request_id;
  IF (NEW.workflow_kind='special' AND parent.request_type<>'special') OR
    (NEW.workflow_kind='backorder' AND (parent.request_type<>'regular' OR parent.workflow_version<>2 OR
      parent.regular_details->>'deliveryMethod' IS DISTINCT FROM 'backorder')) THEN
    RAISE EXCEPTION 'The case profile must match its parent request.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_case_profile BEFORE INSERT OR UPDATE ON sales_special_stock_cases
  FOR EACH ROW EXECUTE FUNCTION enforce_stock_case_profile();

CREATE FUNCTION preserve_backorder_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sales_special_stock_cases WHERE request_id=NEW.id AND workflow_kind='backorder') AND
    (NEW.request_type<>'regular' OR NEW.workflow_version<>2 OR NEW.regular_details->>'deliveryMethod' IS DISTINCT FROM 'backorder') THEN
    RAISE EXCEPTION 'The Backorder parent workflow cannot change.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backorder_parent BEFORE UPDATE ON sales_stock_requests FOR EACH ROW EXECUTE FUNCTION preserve_backorder_parent();

CREATE FUNCTION enforce_backorder_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.request_id IS DISTINCT FROM OLD.request_id AND
    EXISTS(SELECT 1 FROM sales_special_stock_cases WHERE request_id=OLD.request_id AND workflow_kind='backorder') THEN
    RAISE EXCEPTION 'The Backorder material cannot move to another request.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM sales_special_stock_cases WHERE request_id=NEW.request_id AND workflow_kind='backorder') THEN
    IF NEW.regular_item_id IS NULL OR NULLIF(btrim(NEW.regular_item_code),'') IS NULL OR NEW.regular_item_id IN (1784,1987,2055) THEN
      RAISE EXCEPTION 'Backorder requires a regular material SKU.' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (NEW.regular_item_id IS DISTINCT FROM OLD.regular_item_id OR NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
      RAISE EXCEPTION 'The selected Backorder material identity cannot change.' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backorder_material BEFORE INSERT OR UPDATE ON sales_special_stock_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_backorder_material();

CREATE FUNCTION prevent_backorder_generated_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sales_stock_requests WHERE id=NEW.request_id AND regular_details->>'deliveryMethod'='backorder') THEN
    RAISE EXCEPTION 'Backorder cannot generate transfer or order draft lines.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backorder_no_transfer BEFORE INSERT OR UPDATE ON sales_stock_transfers FOR EACH ROW EXECUTE FUNCTION prevent_backorder_generated_lines();
CREATE TRIGGER backorder_no_stock_lines BEFORE INSERT OR UPDATE ON sales_stock_request_lines FOR EACH ROW EXECUTE FUNCTION prevent_backorder_generated_lines();
CREATE TRIGGER backorder_no_order_drafts BEFORE INSERT OR UPDATE ON sales_special_stock_order_lines FOR EACH ROW EXECUTE FUNCTION prevent_backorder_generated_lines();

CREATE OR REPLACE VIEW special_stock_workflow_stages AS
SELECT special.request_id,
  CASE
    WHEN special.close_status = 'closed' OR request.status = 'cancelled' THEN 'closed'
    WHEN (special.workflow_kind <> 'backorder' OR (special.sales_order_netsuite_id IS NOT NULL AND special.purchase_order_netsuite_id IS NOT NULL)) AND (special.operationally_complete OR
      (special.fulfillment_method = 'mbt_delivery' AND EXISTS (
        SELECT 1 FROM dispatch_order_completion_status completion
        WHERE completion.order_kind = 'SO'
          AND lower(btrim(completion.order_ref)) = lower(btrim(special.sales_order_ref)))) OR
      (special.fulfillment_method = 'yard_pickup' AND EXISTS (
        SELECT 1 FROM operator_load_records pickup
        WHERE pickup.order_id = special.sales_order_netsuite_id
          AND pickup.load_type = 'customer_pickup_load'
          AND pickup.response->>'pickupStatus' = 'loaded'))) THEN 'completed'
    WHEN special.information_request->>'status' = 'pending' THEN 'pending_update'
    WHEN special.line_edit_state->>'revision' = request.revision::text
      AND special.line_edit_state->>'stage' IN ('new_enquiry','await_customer_confirmation','wait_for_production','pending_update')
      AND special.sales_order_netsuite_id IS NULL AND special.purchase_order_netsuite_id IS NULL
      AND NOT special.sales_order_skipped AND NOT special.purchase_order_skipped
      THEN special.line_edit_state->>'stage'
    WHEN special.workflow_kind = 'special' AND special.purchase_order_netsuite_id IS NOT NULL AND NOT approval.approved THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND line.sales_decision NOT IN ('accepted','declined','closed'))
      AND EXISTS (SELECT 1 FROM sales_special_stock_lines line
        WHERE line.request_id = special.request_id AND line.sales_decision = 'accepted'
          AND COALESCE(line.supply_status,'') NOT IN ('in_stock','low_inventory')) THEN 'wait_for_production'
    WHEN (special.purchase_order_netsuite_id IS NOT NULL OR special.purchase_order_skipped)
      AND (special.workflow_kind <> 'backorder' OR special.sales_order_netsuite_id IS NOT NULL)
      AND special.fulfillment_method <> 'vendor_pickup' THEN 'dispatch_arrangement'
    WHEN special.sales_order_netsuite_id IS NOT NULL OR special.sales_order_skipped THEN 'confirmed'
    WHEN NOT EXISTS (SELECT 1 FROM sales_special_stock_lines line
      WHERE line.request_id = special.request_id AND (line.supply_status IS NULL OR line.sales_decision = 'request_update')) THEN 'await_customer_confirmation'
    ELSE 'new_enquiry'
  END AS stage
FROM sales_special_stock_cases special
JOIN sales_stock_requests request ON request.id = special.request_id
JOIN special_stock_purchase_approval approval ON approval.request_id = special.request_id;

-- Backorder prices belong to the local quote, including after manual references.
CREATE OR REPLACE FUNCTION preserve_special_original_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE editable boolean;
BEGIN

  IF EXISTS(SELECT 1 FROM sales_special_stock_cases WHERE request_id=OLD.request_id AND workflow_kind='backorder') AND (
    NEW.original_unit_rate IS DISTINCT FROM OLD.original_unit_rate OR NEW.original_rate_uom IS DISTINCT FROM OLD.original_rate_uom
    OR NEW.quoted_discount_percent IS DISTINCT FROM OLD.quoted_discount_percent) THEN
    IF current_setting('mbbs.backorder_case_edit_request',true) IS DISTINCT FROM OLD.request_id::text OR NEW.request_id IS DISTINCT FROM OLD.request_id
      OR NOT EXISTS(SELECT 1 FROM sales_special_stock_cases special JOIN special_stock_workflow_stages stage ON stage.request_id=special.request_id
        WHERE special.request_id=OLD.request_id AND special.close_status='active' AND stage.stage NOT IN ('closed','completed')) THEN
      RAISE EXCEPTION 'Backorder quote prices require its active local Sales editor.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
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
