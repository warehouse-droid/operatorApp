-- Coordination only: no customer, order, credential or HTTP payload data.
CREATE TABLE IF NOT EXISTS netsuite_request_queue (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  priority smallint NOT NULL CHECK (priority IN (0, 1)),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'running')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS netsuite_request_queue_waiting
  ON netsuite_request_queue (priority DESC, sequence) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS netsuite_request_queue_expiry ON netsuite_request_queue (expires_at);
