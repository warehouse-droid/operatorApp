CREATE TABLE regular_stock_delivery_operations (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES operators(id),
  audience text NOT NULL CHECK (audience IN ('sales','scm')),
  action text NOT NULL CHECK (action IN ('preview','submit','retry','decision')),
  request_id bigint REFERENCES sales_stock_requests(id),
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  phase text NOT NULL DEFAULT 'queued',
  result jsonb,
  error text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regular_delivery_one_active_actor ON regular_stock_delivery_operations(actor_id)
  WHERE status IN ('queued','running');
CREATE INDEX regular_delivery_pending ON regular_stock_delivery_operations(created_at)
  WHERE status IN ('queued','running');
CREATE INDEX regular_delivery_completed ON regular_stock_delivery_operations(updated_at)
  WHERE status IN ('succeeded','failed');
