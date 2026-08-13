ALTER TABLE sales_stock_request_lines
  DROP CONSTRAINT IF EXISTS sales_stock_request_lines_status_check;

ALTER TABLE sales_stock_request_lines
  ADD CONSTRAINT sales_stock_request_lines_status_check CHECK (
    status IN (
      'submitted', 'changes_requested', 'converted', 'rejected',
      'received', 'cancelled', 'closed'
    )
  );

ALTER TABLE sales_stock_transfers
  DROP CONSTRAINT IF EXISTS sales_stock_transfers_status_check;

ALTER TABLE sales_stock_transfers
  ADD CONSTRAINT sales_stock_transfers_status_check CHECK (
    status IN (
      'pending_local', 'creating', 'pending_approval', 'pending_fulfillment',
      'partially_fulfilled', 'pending_receipt', 'received', 'cancelled',
      'closed', 'attention'
    )
  );

COMMENT ON CONSTRAINT sales_stock_transfers_status_check ON sales_stock_transfers IS
  'Closed is a distinct terminal NetSuite state; it is not folded into received or cancelled.';
