-- Delivery changes are already persisted in the case event log. Receipts are
-- independent for each user and team, and never change the order workflow.
CREATE TABLE IF NOT EXISTS special_delivery_method_alert_receipts (
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('scm', 'dispatch')),
  event_id bigint NOT NULL REFERENCES sales_special_stock_events(id) ON DELETE CASCADE,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, audience, event_id)
);

CREATE INDEX IF NOT EXISTS special_delivery_method_alert_events_idx
  ON sales_special_stock_events(id)
  WHERE event_type = 'special_delivery_method_updated'
    AND details->>'notifyTeams' = 'true';
