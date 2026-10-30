-- One-off repair: the pickup reset already cleared every packed quantity.
-- Refuse to alter the order if fresh work has appeared since diagnosis.
DO $$
DECLARE
  before_order sales_orders%ROWTYPE;
  before_lines jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('operator-delivery-load:1064528', 0)) THEN
    RAISE EXCEPTION 'SOA10368 is busy; retry the repair.';
  END IF;
  SELECT * INTO STRICT before_order FROM sales_orders WHERE netsuite_id = 1064528 FOR UPDATE;
  IF before_order.tranid <> 'SOA10368' OR before_order.sales_order_type <> 'Pick-Up'
    OR before_order.operator_status <> 'packed' OR before_order.preparing_operator_id IS NOT NULL
    OR before_order.local_yard_order_status <> 'Open' THEN
    RAISE EXCEPTION 'SOA10368 header changed; repair refused.';
  END IF;
  SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) INTO before_lines
    FROM (SELECT * FROM sales_order_lines WHERE sales_order_id = 1064528 ORDER BY id FOR UPDATE) line;
  IF before_lines IS NULL OR EXISTS (
    SELECT 1 FROM sales_order_lines WHERE sales_order_id = 1064528 AND
      (GREATEST(COALESCE(packed_pallet_qty,0),COALESCE(packed_layer_qty,0),COALESCE(packed_section_qty,0),
        COALESCE(packed_piece_qty,0),COALESCE(packed_sales_qty,0),COALESCE(loaded_qty,0),
        COALESCE(fulfilled_pallet_qty,0),COALESCE(fulfilled_layer_qty,0),COALESCE(fulfilled_section_qty,0),COALESCE(fulfilled_piece_qty,0)) <> 0
       OR confirmed OR confirmed_at IS NOT NULL)
  ) OR EXISTS (SELECT 1 FROM operator_load_records WHERE order_id = 1064528)
    OR EXISTS (SELECT 1 FROM operator_consolidated_load_claims WHERE order_id = '1064528' AND active)
    OR EXISTS (SELECT 1 FROM operator_consolidation_claims WHERE canonical_order_id = 1064528 AND released_at IS NULL) THEN
    RAISE EXCEPTION 'SOA10368 has new operational work; repair refused.';
  END IF;
  UPDATE sales_order_lines SET sync_exception = NULL, sync_exception_at = NULL
   WHERE sales_order_id = 1064528 AND sync_exception IN ('qty_reduced','line_deleted');
  UPDATE sales_orders SET operator_status = 'open', preparing_started_at = NULL, status_updated_at = now()
   WHERE netsuite_id = 1064528;
  INSERT INTO delivery_audit_log(actor_type,source,action,order_id,details)
  VALUES('system','operational_repair','delivery.pickup.stale_packing.repair',1064528,
    jsonb_build_object('reason','Delivery changed to Pick-Up; pickup reset left a stale packed header and packing warnings.',
      'beforeOrder',to_jsonb(before_order),'beforeLines',before_lines,'afterStatus','open'));
END;
$$;
