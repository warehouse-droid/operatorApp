-- Independent acknowledgments for each Already Ordered PO reference/planning update.
CREATE TABLE backorder_po_alert_receipts (
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  notice_key text NOT NULL CHECK (notice_key ~ '^[a-f0-9]{64}$'),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, operator_id, notice_key)
);
