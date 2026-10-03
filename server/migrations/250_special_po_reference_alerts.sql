-- Per-user acknowledgement only; PO/case workflow and NetSuite data are unchanged.
CREATE TABLE IF NOT EXISTS special_po_reference_alert_receipts (
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('sales','dispatch')),
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  notice_key text NOT NULL CHECK (notice_key ~ '^[a-f0-9]{64}$'),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, audience, request_id)
);
