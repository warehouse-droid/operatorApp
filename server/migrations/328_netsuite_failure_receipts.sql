-- Separate from operational transactions: client retries must not duplicate audit evidence.
CREATE TABLE IF NOT EXISTS netsuite_failure_receipts (
  actor_key text NOT NULL,
  failure_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_key, failure_id)
);
