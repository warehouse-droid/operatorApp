-- Effective method changes must release delivery drafts in the same transaction.
-- This covers both NetSuite upserts and local Dispatch overrides, including the
-- independently deployed webhook worker. Repeated pickup syncs do not fire.
CREATE OR REPLACE FUNCTION release_delivery_packing_on_pickup()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  released_lines jsonb;
  has_loaded boolean;
  has_remaining boolean;
BEGIN
  -- The header row is already locked. Do not wait for an Operator transaction
  -- that might itself be about to update this row: let the caller retry instead.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('operator-delivery-load:' || NEW.netsuite_id::text, 0)) THEN
    RAISE EXCEPTION 'Order packing/loading is changing; retry the delivery method change.' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM operator_consolidated_load_claims WHERE order_id = NEW.netsuite_id::text AND active) THEN
    RAISE EXCEPTION 'This order belongs to a pending Consolidation Load.' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(draft) ORDER BY draft.id), '[]'::jsonb)
    INTO released_lines
    FROM (
      SELECT id, line_id, packed_pallet_qty, packed_layer_qty, packed_section_qty,
             packed_piece_qty, packed_sales_qty, confirmed, confirmed_at,
             sync_exception, sync_exception_at, loaded_qty,
             (COALESCE(loaded_qty, 0) <= 0 OR GREATEST(COALESCE(packed_pallet_qty, 0),
               COALESCE(packed_layer_qty, 0), COALESCE(packed_section_qty, 0),
               COALESCE(packed_piece_qty, 0), COALESCE(packed_sales_qty, 0)) > 0) AS clear_confirmation
        FROM sales_order_lines
       WHERE sales_order_id = NEW.netsuite_id
         AND (GREATEST(COALESCE(packed_pallet_qty, 0), COALESCE(packed_layer_qty, 0),
               COALESCE(packed_section_qty, 0), COALESCE(packed_piece_qty, 0), COALESCE(packed_sales_qty, 0)) > 0
           OR (confirmed AND COALESCE(loaded_qty, 0) <= 0)
           OR sync_exception IN ('qty_reduced', 'line_deleted'))
       ORDER BY id FOR UPDATE
    ) draft;

  UPDATE sales_order_lines line
     SET packed_pallet_qty = 0, packed_layer_qty = 0, packed_section_qty = 0,
         packed_piece_qty = 0, packed_sales_qty = 0,
         confirmed = CASE WHEN released.clear_confirmation THEN false ELSE line.confirmed END,
         confirmed_at = CASE WHEN released.clear_confirmation THEN NULL ELSE line.confirmed_at END,
         sync_exception = CASE WHEN line.sync_exception IN ('qty_reduced', 'line_deleted') THEN NULL ELSE line.sync_exception END,
         sync_exception_at = CASE WHEN line.sync_exception IN ('qty_reduced', 'line_deleted') THEN NULL ELSE line.sync_exception_at END
    FROM jsonb_to_recordset(released_lines) AS released(id bigint, clear_confirmation boolean)
   WHERE line.id = released.id;

  -- Completed loading and fulfillment are independent of uncommitted packing.
  -- Only replace draft status; preserve existing loaded/fulfilled terminal state.
  IF NEW.operator_status IN ('packed', 'preparing') THEN
    SELECT COALESCE(bool_or(COALESCE(loaded_qty, 0) > 0), false),
           COALESCE(bool_or(COALESCE(NULLIF(GREATEST(quantity, 0), 0),
             GREATEST(COALESCE(pallet_qty, 0), 0) * GREATEST(COALESCE(to_plt, 0), 0)
             + GREATEST(COALESCE(layer_qty, 0), 0) * GREATEST(COALESCE(to_lyr, 0), 0)
             + GREATEST(COALESCE(section_qty, 0), 0) * GREATEST(COALESCE(to_sec, 0), 0)
             + GREATEST(COALESCE(piece_qty, 0), 0) * GREATEST(COALESCE(to_pcs, 0), 0)
           ) > GREATEST(COALESCE(loaded_qty, 0), 0) + 0.000001), false)
      INTO has_loaded, has_remaining
      FROM sales_order_lines
     WHERE sales_order_id = NEW.netsuite_id AND netsuite_active
       AND item_type IN ('InvtPart', 'NonInvtPart')
       AND upper(btrim(COALESCE(NULLIF(sku, ''), item_name, ''))) NOT LIKE 'DELIVERY CHARGE%'
       AND upper(btrim(COALESCE(NULLIF(sku, ''), item_name, ''))) NOT LIKE 'SALES CREDIT%';
    NEW.operator_status := CASE WHEN has_loaded AND has_remaining THEN 'partial_loaded' WHEN has_loaded THEN 'loaded' ELSE 'open' END;
    NEW.local_yard_order_status := CASE WHEN has_loaded AND has_remaining THEN 'Partial Loaded' WHEN has_loaded THEN 'Loaded' ELSE 'Open' END;
  END IF;
  NEW.preparing_operator_id := NULL;
  NEW.preparing_started_at := NULL;
  NEW.status_updated_at := now();

  INSERT INTO delivery_audit_log(actor_type, source, action, order_id, details)
  VALUES ('system', 'delivery_method', 'delivery.packing.release_on_pickup', NEW.netsuite_id,
    jsonb_build_object('fromMethod', OLD.sales_order_type, 'toMethod', NEW.sales_order_type,
      'previousStatus', OLD.operator_status, 'status', NEW.operator_status,
      'previousPreparingOperatorId', OLD.preparing_operator_id,
      'previousPreparingStartedAt', OLD.preparing_started_at, 'releasedLines', released_lines));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS release_delivery_packing_on_pickup ON sales_orders;
CREATE TRIGGER release_delivery_packing_on_pickup
BEFORE UPDATE OF sales_order_type ON sales_orders
FOR EACH ROW WHEN (btrim(OLD.sales_order_type) = 'Delivery' AND btrim(NEW.sales_order_type) = 'Pick-Up')
EXECUTE FUNCTION release_delivery_packing_on_pickup();
