-- Local directory used by the Return workflow customer search. NetSuite is
-- authoritative; a successful full refresh atomically replaces this snapshot.

CREATE TABLE IF NOT EXISTS return_customer_directory (
  netsuite_customer_id bigint PRIMARY KEY,
  entity_code text NOT NULL,
  company_name text NOT NULL DEFAULT '',
  display_name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  phone_digits text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  sync_generation uuid,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_customer_directory_id_check CHECK (netsuite_customer_id > 0)
);

CREATE INDEX IF NOT EXISTS idx_return_customer_directory_entity_code
  ON return_customer_directory (lower(entity_code) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_return_customer_directory_company_name
  ON return_customer_directory (lower(company_name) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_return_customer_directory_display_name
  ON return_customer_directory (lower(display_name) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_return_customer_directory_phone
  ON return_customer_directory (phone_digits text_pattern_ops);

CREATE TABLE IF NOT EXISTS return_customer_directory_sync (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  status text NOT NULL DEFAULT 'idle',
  current_run_token uuid,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_successful_at timestamptz,
  last_error text,
  customer_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_customer_directory_sync_singleton CHECK (singleton_id = 1),
  CONSTRAINT return_customer_directory_sync_status
    CHECK (status IN ('idle', 'running', 'succeeded', 'failed')),
  CONSTRAINT return_customer_directory_sync_count CHECK (customer_count >= 0)
);

INSERT INTO return_customer_directory_sync (singleton_id)
VALUES (1)
ON CONFLICT (singleton_id) DO NOTHING;

COMMENT ON TABLE return_customer_directory IS
  'Last complete active NetSuite customer snapshot for local Return searches.';

COMMENT ON TABLE return_customer_directory_sync IS
  'Lease and health metadata for the active NetSuite customer directory refresh.';
