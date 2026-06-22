ALTER TABLE receiving_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_received_qty numeric NOT NULL DEFAULT 0;
