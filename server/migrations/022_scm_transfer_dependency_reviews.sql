ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS is_test_fixture boolean NOT NULL DEFAULT false;

UPDATE sales_orders
   SET is_test_fixture = true
 WHERE tranid LIKE 'TSTDEP-SO-%';

CREATE INDEX IF NOT EXISTS idx_sales_orders_test_fixture
  ON sales_orders (is_test_fixture, tranid)
  WHERE is_test_fixture = true;

CREATE TABLE IF NOT EXISTS scm_transfer_dependency_reviews (
  sales_order_id bigint PRIMARY KEY REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'reviewed',
  shortage_signature text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reopened_by text,
  reopened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_transfer_dependency_reviews_status_check
    CHECK (status IN ('reviewed', 'stale'))
);

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_reviews_status
  ON scm_transfer_dependency_reviews (status, reviewed_at DESC);
