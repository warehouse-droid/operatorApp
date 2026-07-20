CREATE TABLE IF NOT EXISTS netsuite_mirror_sequence (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  last_sequence bigint NOT NULL DEFAULT 0
);

INSERT INTO netsuite_mirror_sequence (singleton_id, last_sequence)
VALUES (1, 0)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS netsuite_mirror_events (
  sequence_id bigint PRIMARY KEY,
  event_uuid uuid NOT NULL UNIQUE,
  entity_type text NOT NULL CHECK (entity_type IN ('sales_order', 'purchase_order', 'transfer_order', 'inventory')),
  entity_id text NOT NULL,
  change_type text NOT NULL DEFAULT 'upsert',
  source text NOT NULL DEFAULT 'netsuite-sync',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_netsuite_mirror_events_delivery
  ON netsuite_mirror_events (status, next_attempt_at, sequence_id);

CREATE INDEX IF NOT EXISTS idx_netsuite_mirror_events_entity
  ON netsuite_mirror_events (entity_type, entity_id, sequence_id DESC);

CREATE INDEX IF NOT EXISTS idx_netsuite_mirror_events_created
  ON netsuite_mirror_events (created_at);

CREATE TABLE IF NOT EXISTS netsuite_mirror_inbox (
  event_uuid uuid PRIMARY KEY,
  source_sequence bigint NOT NULL UNIQUE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  change_type text NOT NULL,
  source text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_netsuite_mirror_inbox_processing
  ON netsuite_mirror_inbox (status, source_sequence);

CREATE TABLE IF NOT EXISTS netsuite_mirror_state (
  state_key text PRIMARY KEY,
  state_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE netsuite_mirror_sequence IS
  'Transactional source event allocator. Unlike a PostgreSQL sequence, rolled-back events do not leave cursor gaps.';

COMMENT ON TABLE netsuite_mirror_events IS
  'Durable source outbox for normalized NetSuite entity changes relayed to an isolated application database.';

COMMENT ON TABLE netsuite_mirror_inbox IS
  'Idempotent consumer inbox. Source sequence advances only after the corresponding snapshot transaction commits.';
