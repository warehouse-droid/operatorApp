-- Observations survive plan saves. Acknowledgement is a separate review action,
-- never a prerequisite for saving more work after an authoritative source edit.
CREATE TABLE dispatch_executed_order_reviews (
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  token text NOT NULL CHECK (token ~ '^[a-f0-9]{64}$'),
  order_ref text NOT NULL,
  source_digest text NOT NULL,
  review jsonb NOT NULL,
  changes jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  actor_id text REFERENCES operators(id) ON DELETE SET NULL,
  actor_name text NOT NULL DEFAULT '',
  PRIMARY KEY (plan_id, token),
  UNIQUE (plan_id, order_ref, source_digest)
);
CREATE INDEX dispatch_executed_order_reviews_pending
  ON dispatch_executed_order_reviews (plan_id, observed_at)
  WHERE acknowledged_at IS NULL;
