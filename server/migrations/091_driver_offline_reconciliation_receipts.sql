CREATE TABLE IF NOT EXISTS driver_offline_reconciliation_receipts (
  receipt_id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE
    REFERENCES driver_offline_events(event_id) ON DELETE CASCADE,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  action_type text NOT NULL,
  context_hash char(64) NOT NULL,
  request_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'executing',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_reconciliation_receipts_login_not_blank
    CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_offline_reconciliation_receipts_device_not_blank
    CHECK (btrim(device_id) <> ''),
  CONSTRAINT driver_offline_reconciliation_receipts_action_valid
    CHECK (action_type IN ('dvir', 'duty')),
  CONSTRAINT driver_offline_reconciliation_receipts_status_valid
    CHECK (status IN ('executing', 'applied', 'uncertain')),
  CONSTRAINT driver_offline_reconciliation_receipts_context_hash_valid
    CHECK (context_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_driver_offline_reconciliation_receipts_driver
  ON driver_offline_reconciliation_receipts (lower(driver_login), started_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_offline_reconciliation_receipts_status
  ON driver_offline_reconciliation_receipts (status, updated_at);

COMMENT ON TABLE driver_offline_reconciliation_receipts IS
  'Durable exactly-once guard for interactive Samsara reconciliation of an already-applied offline Driver event. Executing or uncertain outcomes are never replayed automatically.';
