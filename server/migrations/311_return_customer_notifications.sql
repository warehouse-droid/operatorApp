CREATE TABLE IF NOT EXISTS return_customer_notifications (
  id bigserial PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES return_batches(id),
  reference_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'uncertain')),
  message_text text NOT NULL,
  provider_id text,
  operator_id text NOT NULL REFERENCES operators(id),
  attempt_date date NOT NULL DEFAULT CURRENT_DATE,
  attempts_today integer NOT NULL DEFAULT 1 CHECK (attempts_today > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, reference_key, channel, recipient)
);
COMMENT ON TABLE return_customer_notifications IS
  'Operator-requested customer messages. Sent means provider accepted; uncertain sends must never retry automatically.';
