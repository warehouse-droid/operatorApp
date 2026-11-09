-- Operator Web Push: urgent Delivery Prep alerts reach Operator devices while the app is closed or
-- the device is asleep (Android / Windows). Same VAPID keys as Driver and Repair push.
--
-- operator_push_subscriptions: one row per browser push endpoint. A shared tablet keeps one
-- endpoint; the account that signed in last owns it (upsert by endpoint). location_id is the yard
-- the device last selected; alerts go to the devices at the order's yard. Revoked rows are kept
-- for audit (logout, permission removed, or the push service answered 404/410).
CREATE TABLE IF NOT EXISTS operator_push_subscriptions (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  location_id integer NOT NULL,
  language text NOT NULL DEFAULT 'en',
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_error text,
  revoked_at timestamptz,
  revoked_reason text
);

CREATE INDEX IF NOT EXISTS operator_push_subscriptions_active_yard_idx
  ON operator_push_subscriptions (location_id) WHERE revoked_at IS NULL;

-- operator_push_delivery_state: the Delivery Prep alert list the server last saw per yard, keyed
-- the same way as the Operator page (type:orderId -> full notification key). The server alerts
-- when an item appears already planned or its key changes, exactly like an open Operator page.
-- operator_push_yards marks a yard whose state has been seeded, so the first check after
-- deployment (or after a yard gets its first device) records the list without alerting.
CREATE TABLE IF NOT EXISTS operator_push_delivery_state (
  location_id integer NOT NULL,
  base_key text NOT NULL,
  notification_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, base_key)
);

CREATE TABLE IF NOT EXISTS operator_push_yards (
  location_id integer PRIMARY KEY,
  seeded_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz
);
