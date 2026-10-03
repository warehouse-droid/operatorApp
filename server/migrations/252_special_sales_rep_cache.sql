CREATE TABLE IF NOT EXISTS special_stock_sales_rep_cache (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  reps jsonb NOT NULL CHECK (jsonb_typeof(reps) = 'array'),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
