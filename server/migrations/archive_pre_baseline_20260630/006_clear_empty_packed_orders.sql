UPDATE delivery_orders o
SET operator_status = 'open',
    prepared = false,
    prepared_at = null,
    status_updated_at = now()
WHERE operator_status = 'packed'
  AND NOT EXISTS (
    SELECT 1
    FROM delivery_order_lines l
    WHERE l.order_id = o.netsuite_id
      AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
      AND (
        COALESCE(l.packed_pallet_qty, 0) > 0
        OR COALESCE(l.packed_section_qty, 0) > 0
        OR COALESCE(l.packed_layer_qty, 0) > 0
        OR COALESCE(l.packed_piece_qty, 0) > 0
      )
  );
