ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS sync_exception text,
  ADD COLUMN IF NOT EXISTS sync_exception_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_delivery_lines_sync_exception
  ON delivery_order_lines (order_id, sync_exception)
  WHERE sync_exception IS NOT NULL;
