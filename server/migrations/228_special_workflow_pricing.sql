ALTER TABLE sales_special_stock_lines
  ADD COLUMN IF NOT EXISTS original_unit_rate numeric(18,6),
  ADD COLUMN IF NOT EXISTS original_rate_uom text,
  ADD COLUMN IF NOT EXISTS pricing_source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS quoted_discount_percent numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_percent numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sales_package_quantity numeric,
  ADD COLUMN IF NOT EXISTS pieces_per_unit numeric,
  ADD COLUMN IF NOT EXISTS scm_reviewed_quantity numeric,
  ADD COLUMN IF NOT EXISTS scm_reviewed_pieces_per_unit numeric;

UPDATE sales_special_stock_lines line
   SET original_unit_rate = orders.unit_rate, original_rate_uom = orders.uom,
       pricing_source = 'legacy_order', sales_package_quantity = orders.quantity,
       pieces_per_unit = 1, scm_reviewed_quantity = orders.quantity,
       scm_reviewed_pieces_per_unit = 1
  FROM sales_special_stock_order_lines orders
 WHERE orders.case_line_id = line.id AND orders.order_kind = 'sales_order'
   AND line.original_unit_rate IS NULL AND orders.unit_rate IS NOT NULL;
UPDATE sales_special_stock_lines
   SET scm_reviewed_quantity = COALESCE(sales_package_quantity, sales_quantity, requested_quantity)
 WHERE scm_reviewed_quantity IS NULL;

ALTER TABLE sales_special_stock_lines DROP CONSTRAINT IF EXISTS special_line_pricing_check;
ALTER TABLE sales_special_stock_lines ADD CONSTRAINT special_line_pricing_check CHECK (
  (original_unit_rate IS NULL OR original_unit_rate BETWEEN 0 AND 1000000000)
  AND quoted_discount_percent BETWEEN 0 AND 100 AND discount_percent BETWEEN 0 AND 100
  AND (sales_package_quantity IS NULL OR sales_package_quantity > 0)
  AND (pieces_per_unit IS NULL OR pieces_per_unit > 0)
  AND scm_reviewed_quantity > 0
  AND (scm_reviewed_pieces_per_unit IS NULL OR scm_reviewed_pieces_per_unit > 0)
);

CREATE OR REPLACE FUNCTION preserve_special_original_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.original_unit_rate IS NOT NULL AND (
    NEW.original_unit_rate IS DISTINCT FROM OLD.original_unit_rate
    OR NEW.original_rate_uom IS DISTINCT FROM OLD.original_rate_uom
    OR NEW.quoted_discount_percent IS DISTINCT FROM OLD.quoted_discount_percent
  ) THEN
    RAISE EXCEPTION 'The original Special Item rate and price basis are immutable.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS special_original_price_immutable ON sales_special_stock_lines;
CREATE TRIGGER special_original_price_immutable BEFORE UPDATE ON sales_special_stock_lines
  FOR EACH ROW EXECUTE FUNCTION preserve_special_original_price();

ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS quantity_review jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT IF EXISTS special_quantity_review_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT special_quantity_review_check CHECK (
  jsonb_typeof(quantity_review) = 'object'
  AND COALESCE(quantity_review->>'status', 'none') IN ('none','pending','applying','attention','approved','rejected')
);
CREATE INDEX IF NOT EXISTS idx_special_quantity_review_queue
  ON sales_special_stock_cases ((quantity_review->>'status'), updated_at DESC)
  WHERE quantity_review->>'status' IN ('pending','applying','attention');
