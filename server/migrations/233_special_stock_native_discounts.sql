-- NULL retains the legacy embedded-rate representation without repricing orders.
ALTER TABLE sales_special_stock_order_lines
  ADD COLUMN IF NOT EXISTS native_discount_percent numeric(7,4);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='special_native_discount_check') THEN
    ALTER TABLE sales_special_stock_order_lines ADD CONSTRAINT special_native_discount_check CHECK (
      native_discount_percent IS NULL OR
      (order_kind='sales_order' AND ancillary=false AND item_id=2055 AND native_discount_percent BETWEEN 0 AND 100)
    );
  END IF;
END $$;
