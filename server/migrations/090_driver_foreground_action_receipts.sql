CREATE TABLE IF NOT EXISTS driver_foreground_action_receipts (
  event_id uuid PRIMARY KEY,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  action_type text NOT NULL,
  target_id text NOT NULL DEFAULT '',
  event_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_occurred_at timestamptz,
  status text NOT NULL DEFAULT 'executing',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_foreground_action_receipts_login_not_blank
    CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_foreground_action_receipts_device_not_blank
    CHECK (btrim(device_id) <> ''),
  CONSTRAINT driver_foreground_action_receipts_action_valid
    CHECK (action_type IN (
      'job_started',
      'dvir_captured',
      'truck_switched_physical',
      'truck_switched_samsara_skipped'
    )),
  CONSTRAINT driver_foreground_action_receipts_status_valid
    CHECK (status IN ('executing', 'applied', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_driver_foreground_action_receipts_driver
  ON driver_foreground_action_receipts (lower(driver_login), created_at DESC);

COMMENT ON TABLE driver_foreground_action_receipts IS
  'Durable idempotency bridge for local-first Driver PWA actions that perform an interactive online Samsara write before their offline event envelope is synchronized.';
