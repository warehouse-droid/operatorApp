ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS delivery_fee_rate numeric
  CHECK (delivery_fee_rate >= 0 AND delivery_fee_rate <= 1000000000
    AND delivery_fee_rate = round(delivery_fee_rate, 6));
