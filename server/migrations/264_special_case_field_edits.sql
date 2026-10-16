-- Permit validated pre-order Sales/SCM corrections. After issue, only an applying
-- SCM review may change its exact saved UOM; original rates/quoted discounts stay fixed.
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
