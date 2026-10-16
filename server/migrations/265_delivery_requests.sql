-- Delivery availability approvals are separate from transport jobs and orders.
CREATE TABLE IF NOT EXISTS delivery_request_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  settings jsonb NOT NULL DEFAULT '{"pos":26,"bin":1,"approvalHours":3,"reminderHours":1}',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text REFERENCES operators(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO delivery_request_settings(id) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS delivery_request_quotes (
  id uuid PRIMARY KEY, requesting_yard_location_id integer NOT NULL CHECK (requesting_yard_location_id IN (1,28,15,26)),
  pricing jsonb NOT NULL, settings_revision integer NOT NULL, quote jsonb NOT NULL,
  created_by text NOT NULL REFERENCES operators(id), created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS delivery_request_quotes_expiry ON delivery_request_quotes(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS delivery_requests (
  id bigserial PRIMARY KEY,
  requesting_yard_location_id integer NOT NULL CHECK (requesting_yard_location_id IN (1,28,15,26)),
  status text NOT NULL CHECK (status IN ('submitted','proposed','preapproved','confirmed','expired','cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), data jsonb NOT NULL,
  approval_expires_at timestamptz, reminder_at timestamptz, reminder_sent_at timestamptz,
  created_by text NOT NULL REFERENCES operators(id), last_actor_id text REFERENCES operators(id),
  last_action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('preapproved','proposed')) = (approval_expires_at IS NOT NULL)),
  CHECK (status <> 'confirmed' OR (jsonb_array_length(data->'salesOrderRefs') > 0 AND data->>'securedAt' IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS delivery_requests_yard_updates ON delivery_requests(requesting_yard_location_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS delivery_requests_expiry ON delivery_requests(approval_expires_at) WHERE approval_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS delivery_request_events (
  id bigserial PRIMARY KEY, request_id bigint NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
  revision integer NOT NULL, action text NOT NULL, actor_id text REFERENCES operators(id),
  actor_name text NOT NULL DEFAULT '', message text NOT NULL DEFAULT '', snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id, revision)
);
CREATE TABLE IF NOT EXISTS delivery_request_reads (
  request_id bigint NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  read_revision integer NOT NULL CHECK (read_revision > 0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id, operator_id)
);
CREATE TABLE IF NOT EXISTS delivery_request_operations (
  operator_id text NOT NULL REFERENCES operators(id), operation_id uuid NOT NULL,
  fingerprint text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(operator_id, operation_id)
);
CREATE TABLE IF NOT EXISTS delivery_request_sales_orders (
  request_id bigint NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
  order_ref text NOT NULL, PRIMARY KEY(request_id, order_ref)
);
CREATE INDEX IF NOT EXISTS delivery_request_sales_orders_ref ON delivery_request_sales_orders(order_ref, request_id);
