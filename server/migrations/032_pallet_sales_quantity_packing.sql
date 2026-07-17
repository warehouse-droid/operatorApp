UPDATE sales_order_lines
   SET packed_sales_qty = packed_piece_qty,
       packed_piece_qty = 0
 WHERE UPPER(COALESCE(NULLIF(sku, ''), item_name, '')) = 'PALLET'
   AND COALESCE(to_plt, 0) = 0
   AND COALESCE(to_lyr, 0) = 0
   AND COALESCE(to_sec, 0) = 0
   AND COALESCE(to_pcs, 0) = 0
   AND COALESCE(pallet_qty, 0) = 0
   AND COALESCE(layer_qty, 0) = 0
   AND COALESCE(section_qty, 0) = 0
   AND COALESCE(piece_qty, 0) = 0
   AND COALESCE(packed_piece_qty, 0) > 0
   AND COALESCE(packed_sales_qty, 0) = 0;

UPDATE transfer_order_lines
   SET packed_sales_qty = packed_piece_qty,
       packed_piece_qty = 0
 WHERE UPPER(COALESCE(NULLIF(sku, ''), item_name, '')) = 'PALLET'
   AND line_stage = 'outbound'
   AND COALESCE(to_plt, 0) = 0
   AND COALESCE(to_lyr, 0) = 0
   AND COALESCE(to_sec, 0) = 0
   AND COALESCE(to_pcs, 0) = 0
   AND COALESCE(pallet_qty, 0) = 0
   AND COALESCE(layer_qty, 0) = 0
   AND COALESCE(section_qty, 0) = 0
   AND COALESCE(piece_qty, 0) = 0
   AND COALESCE(packed_piece_qty, 0) > 0
   AND COALESCE(packed_sales_qty, 0) = 0;
