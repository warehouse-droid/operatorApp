UPDATE delivery_orders o
SET operator_status = 'packed',
    prepared = true,
    prepared_at = COALESCE(prepared_at, now()),
    preparing_operator_id = null,
    preparing_started_at = null,
    status_updated_at = now()
WHERE operator_status = 'preparing'
  AND preparing_operator_id = 'legacy-preparing'
  AND EXISTS (
    SELECT 1
    FROM delivery_order_lines l
    WHERE l.order_id = o.netsuite_id
      AND (
        COALESCE(l.packed_pallet_qty, 0) > 0
        OR COALESCE(l.packed_section_qty, 0) > 0
        OR COALESCE(l.packed_layer_qty, 0) > 0
        OR COALESCE(l.packed_piece_qty, 0) > 0
      )
  );
