-- PO receipt notifications are independent of request revision notices.
ALTER TABLE regular_stock_decision_reads
  ADD COLUMN backorder_arrival_key text NOT NULL DEFAULT ''
  CHECK (backorder_arrival_key = '' OR backorder_arrival_key ~ '^[a-f0-9]{64}$');
