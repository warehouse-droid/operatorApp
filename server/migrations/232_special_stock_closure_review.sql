ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS closure_review jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sales_special_stock_cases DROP CONSTRAINT IF EXISTS special_closure_review_check;
ALTER TABLE sales_special_stock_cases ADD CONSTRAINT special_closure_review_check CHECK (
  jsonb_typeof(closure_review) = 'object' AND
  (closure_review = '{}'::jsonb OR closure_review->>'status' IN ('pending','applying','attention','approved','rejected'))
);
