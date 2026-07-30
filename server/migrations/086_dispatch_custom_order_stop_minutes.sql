ALTER TABLE dispatch_custom_orders
  ADD COLUMN IF NOT EXISTS stop_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'dispatch_custom_orders_stop_minutes_valid'
       AND conrelid = 'dispatch_custom_orders'::regclass
  ) THEN
    ALTER TABLE dispatch_custom_orders
      ADD CONSTRAINT dispatch_custom_orders_stop_minutes_valid
      CHECK (stop_minutes IS NULL OR stop_minutes BETWEEN 0 AND 1440);
  END IF;
END
$$;

COMMENT ON COLUMN dispatch_custom_orders.stop_minutes IS
  'Dispatcher-entered destination service time in minutes. NULL keeps the legacy per-driver delivery timing rule.';
