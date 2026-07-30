-- Keep the authoritative local reservation checks cheap as return history grows.
-- NetSuite history remains the source for remote IF/Credit Memo and
-- Return Authorization/Credit Memo quantities.

CREATE INDEX IF NOT EXISTS idx_return_records_pallet_reservation
  ON return_records (customer_id)
  INCLUDE (
    pallet_quantity,
    netsuite_stage,
    external_id,
    netsuite_transaction_id
  )
  WHERE record_type = 'pallet'
    AND status NOT IN ('rejected', 'voided');

CREATE INDEX IF NOT EXISTS idx_return_lines_stock_reservation
  ON return_record_lines (source_sales_order_line_id, return_record_id)
  INCLUDE (returned_sales_quantity)
  WHERE approval_status IN ('not_required', 'pending', 'approved');
