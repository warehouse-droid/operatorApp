CREATE TABLE return_automatic_notifications (
  batch_id bigint PRIMARY KEY REFERENCES return_batches(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','processing','retry','sent','failed','uncertain','no_contact','cancelled')),
  channel text CHECK (channel IN ('sms','email')),
  recipient text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_automatic_notifications_pending ON return_automatic_notifications(next_attempt_at)
  WHERE status IN ('pending','retry','processing');
COMMENT ON TABLE return_automatic_notifications IS
  'Post-commit customer confirmation outbox for new verified return CMs. Recipient is frozen before sending; uncertain delivery is never retried automatically.';
