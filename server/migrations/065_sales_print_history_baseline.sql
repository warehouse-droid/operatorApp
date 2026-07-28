CREATE TABLE IF NOT EXISTS sales_print_history_baseline (
  order_id bigint PRIMARY KEY,
  order_ref text,
  marked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'printed_before_mbbs_tracking'
);

CREATE INDEX IF NOT EXISTS idx_sales_print_history_baseline_marked
  ON sales_print_history_baseline (marked_at DESC, order_id DESC);

COMMENT ON TABLE sales_print_history_baseline IS
  'One-time membership snapshot of Sales Orders already printed outside the MBBS print queue.';
