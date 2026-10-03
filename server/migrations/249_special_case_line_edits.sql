-- Preserve the quoted basis and discounts. Only the authenticated case editor
-- can change a selling rate, on its locked request before order creation.
CREATE OR REPLACE FUNCTION preserve_special_original_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE editable boolean;
BEGIN
  IF OLD.original_unit_rate IS NOT NULL AND (
    NEW.original_rate_uom IS DISTINCT FROM OLD.original_rate_uom
    OR NEW.quoted_discount_percent IS DISTINCT FROM OLD.quoted_discount_percent
  ) THEN
    RAISE EXCEPTION 'The original Special Item price basis and quoted discount are immutable.' USING ERRCODE = '23514';
  END IF;
  IF OLD.original_unit_rate IS NOT NULL AND NEW.original_unit_rate IS DISTINCT FROM OLD.original_unit_rate THEN
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
