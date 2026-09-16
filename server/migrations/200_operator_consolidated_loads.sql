CREATE TABLE operator_consolidated_loads (
  id uuid PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id),
  location_id bigint NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  photo_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','completed')),
  command_id uuid REFERENCES operator_netsuite_posting_commands(id),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX operator_consolidated_loads_pending_idx
  ON operator_consolidated_loads(operator_id,location_id,updated_at) WHERE status='pending';
CREATE TABLE operator_consolidated_load_claims (
  batch_id uuid NOT NULL REFERENCES operator_consolidated_loads(id),
  order_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(batch_id,order_id)
);
CREATE UNIQUE INDEX operator_consolidated_load_claims_active_idx
  ON operator_consolidated_load_claims(order_id) WHERE active;
