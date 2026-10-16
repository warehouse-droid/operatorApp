BEGIN;
-- Forward-only capture: deployment must never replay historical completions.
CREATE TABLE IF NOT EXISTS transfer_order_posting_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL CHECK(transaction_type IN ('IF','IR')),
  local_to_id bigint NOT NULL REFERENCES transfer_orders(netsuite_id),
  order_ref text NOT NULL,
  operator_id text REFERENCES operators(id),
  operator_record_id bigint NOT NULL,
  snapshot jsonb NOT NULL,
  completion_event_id bigint REFERENCES dispatch_order_completion_events(id),
  command_id uuid UNIQUE REFERENCES operator_netsuite_posting_commands(id),
  status text NOT NULL DEFAULT 'waiting_driver' CHECK(status IN
    ('waiting_driver','waiting_fulfillment','waiting_posting','gate_disabled','admitted','completed','attention')),
  last_error text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_type,operator_record_id)
);
CREATE INDEX IF NOT EXISTS transfer_order_posting_jobs_pending
  ON transfer_order_posting_jobs(created_at) WHERE command_id IS NULL;
CREATE INDEX IF NOT EXISTS transfer_order_posting_jobs_order ON transfer_order_posting_jobs(local_to_id,transaction_type);
COMMIT;
