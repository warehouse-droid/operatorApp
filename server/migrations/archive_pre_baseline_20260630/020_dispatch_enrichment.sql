ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS memo text,
  ADD COLUMN IF NOT EXISTS dispatch_address text,
  ADD COLUMN IF NOT EXISTS dispatch_window_start text,
  ADD COLUMN IF NOT EXISTS dispatch_window_end text,
  ADD COLUMN IF NOT EXISTS dispatch_instructions text,
  ADD COLUMN IF NOT EXISTS dispatch_parse_source text,
  ADD COLUMN IF NOT EXISTS dispatch_note_hash text,
  ADD COLUMN IF NOT EXISTS dispatch_parsed_at timestamptz;

ALTER TABLE receiving_orders
  ADD COLUMN IF NOT EXISTS memo text,
  ADD COLUMN IF NOT EXISTS dispatch_address text,
  ADD COLUMN IF NOT EXISTS dispatch_window_start text,
  ADD COLUMN IF NOT EXISTS dispatch_window_end text,
  ADD COLUMN IF NOT EXISTS dispatch_instructions text,
  ADD COLUMN IF NOT EXISTS dispatch_vendor_yard text,
  ADD COLUMN IF NOT EXISTS dispatch_parse_source text,
  ADD COLUMN IF NOT EXISTS dispatch_note_hash text,
  ADD COLUMN IF NOT EXISTS dispatch_parsed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_delivery_orders_dispatch_window
  ON delivery_orders (dispatch_window_start, trandate DESC);

CREATE INDEX IF NOT EXISTS idx_receiving_orders_dispatch_window
  ON receiving_orders (dispatch_window_start, trandate DESC);
