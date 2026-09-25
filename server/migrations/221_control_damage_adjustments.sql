CREATE TABLE inventory_damage_adjustments (
  id uuid PRIMARY KEY,
  month_id bigint NOT NULL REFERENCES inventory_damage_months(id),
  transfer_id bigint NOT NULL,
  actor_id text NOT NULL REFERENCES operators(id),
  request_hash text NOT NULL,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posting','posted','attention','conflict')),
  safe_to_retry boolean NOT NULL DEFAULT true,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz
);
CREATE INDEX inventory_damage_adjustments_month ON inventory_damage_adjustments(month_id,created_at DESC);
CREATE INDEX inventory_damage_adjustments_pending ON inventory_damage_adjustments(created_at) WHERE status IN ('pending','posting');
