-- Existing dated transfer checks retain their dates; new checks opt into the relative policy.
ALTER TABLE sales_special_stock_cases
  ADD COLUMN IF NOT EXISTS sales_order_placed_date date;

ALTER TABLE sales_special_stock_lines
  DROP CONSTRAINT sales_special_stock_line_availability_check;
ALTER TABLE sales_special_stock_lines
  ADD CONSTRAINT sales_special_stock_line_availability_check CHECK (
    (availability_mode IS NULL AND available_date IS NULL)
    OR (availability_mode = 'dated' AND available_date IS NOT NULL)
    OR (availability_mode = 'no_projection' AND available_date IS NULL)
    OR (availability_mode = 'so_placement' AND supply_status IS NOT DISTINCT FROM 'vendor_transfer')
  );
