ALTER TABLE IF EXISTS customer_pickup_load_records
  DROP CONSTRAINT IF EXISTS customer_pickup_load_records_order_id_fkey;

ALTER TABLE IF EXISTS delivery_audit_log
  DROP CONSTRAINT IF EXISTS delivery_audit_log_order_id_fkey;

ALTER TABLE IF EXISTS delivery_fulfillment_records
  DROP CONSTRAINT IF EXISTS delivery_fulfillment_records_order_id_fkey;

ALTER TABLE IF EXISTS delivery_preparation_records
  DROP CONSTRAINT IF EXISTS delivery_preparation_records_order_id_fkey;

ALTER TABLE IF EXISTS local_co_receipt_records
  DROP CONSTRAINT IF EXISTS local_co_receipt_records_created_delivery_order_id_fkey;

ALTER TABLE IF EXISTS receiving_receipt_records
  DROP CONSTRAINT IF EXISTS receiving_receipt_records_order_id_fkey;

ALTER TABLE IF EXISTS dispatch_so_po_allocations
  DROP CONSTRAINT IF EXISTS dispatch_so_po_allocations_sales_order_id_fkey,
  DROP CONSTRAINT IF EXISTS dispatch_so_po_allocations_sales_line_id_fkey,
  DROP CONSTRAINT IF EXISTS dispatch_so_po_allocations_po_order_id_fkey,
  DROP CONSTRAINT IF EXISTS dispatch_so_po_allocations_po_line_id_fkey;

ALTER TABLE IF EXISTS dispatch_so_po_allocations
  ADD CONSTRAINT dispatch_so_po_allocations_sales_order_id_fkey
    FOREIGN KEY (sales_order_id) REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT dispatch_so_po_allocations_sales_line_id_fkey
    FOREIGN KEY (sales_line_id) REFERENCES sales_order_lines(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT dispatch_so_po_allocations_po_order_id_fkey
    FOREIGN KEY (po_order_id) REFERENCES purchase_orders(netsuite_id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT dispatch_so_po_allocations_po_line_id_fkey
    FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines(id) ON DELETE CASCADE NOT VALID;

DROP TRIGGER IF EXISTS trg_delivery_orders_canonical ON delivery_orders;
DROP TRIGGER IF EXISTS trg_delivery_order_lines_canonical ON delivery_order_lines;
DROP TRIGGER IF EXISTS trg_receiving_orders_canonical ON receiving_orders;
DROP TRIGGER IF EXISTS trg_receiving_order_lines_canonical ON receiving_order_lines;

DROP TRIGGER IF EXISTS trg_sales_orders_dispatch_legacy ON sales_orders;
DROP TRIGGER IF EXISTS trg_sales_lines_operator_legacy ON sales_order_lines;
DROP TRIGGER IF EXISTS trg_purchase_orders_dispatch_legacy ON purchase_orders;
DROP TRIGGER IF EXISTS trg_purchase_orders_receiving_legacy ON purchase_orders;
DROP TRIGGER IF EXISTS trg_purchase_lines_receiving_legacy ON purchase_order_lines;
DROP TRIGGER IF EXISTS trg_transfer_orders_dispatch_legacy ON transfer_orders;
DROP TRIGGER IF EXISTS trg_transfer_orders_receiving_legacy ON transfer_orders;
DROP TRIGGER IF EXISTS trg_transfer_lines_operator_legacy ON transfer_order_lines;
DROP TRIGGER IF EXISTS trg_transfer_lines_receiving_legacy ON transfer_order_lines;

DROP FUNCTION IF EXISTS mbbs_delivery_order_canonical_trigger();
DROP FUNCTION IF EXISTS mbbs_delivery_line_canonical_trigger();
DROP FUNCTION IF EXISTS mbbs_receiving_order_canonical_trigger();
DROP FUNCTION IF EXISTS mbbs_receiving_line_canonical_trigger();
DROP FUNCTION IF EXISTS mbbs_sales_order_dispatch_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_sales_line_operator_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_purchase_order_dispatch_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_purchase_order_receiving_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_purchase_line_receiving_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_transfer_order_dispatch_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_transfer_order_receiving_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_transfer_line_operator_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_transfer_line_receiving_legacy_trigger();
DROP FUNCTION IF EXISTS mbbs_rebuild_sales_order(bigint);
DROP FUNCTION IF EXISTS mbbs_rebuild_sales_order_lines(bigint);
DROP FUNCTION IF EXISTS mbbs_rebuild_transfer_order(bigint);
DROP FUNCTION IF EXISTS mbbs_rebuild_transfer_order_lines(bigint, text);
DROP FUNCTION IF EXISTS mbbs_rebuild_purchase_order(bigint);
DROP FUNCTION IF EXISTS mbbs_rebuild_purchase_order_lines(bigint);
