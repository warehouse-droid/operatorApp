CREATE TABLE operator_password_resets (
  identity_hash text PRIMARY KEY,
  operator_id text REFERENCES operators(id) ON DELETE CASCADE,
  email text NOT NULL DEFAULT '',
  password_version text,
  challenge_id uuid UNIQUE NOT NULL,
  code_hash text,
  code_salt text,
  code_expires_at timestamptz,
  requested_at timestamptz NOT NULL,
  resend_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  proof_hash text UNIQUE,
  proof_expires_at timestamptz
);
CREATE INDEX operator_password_resets_age ON operator_password_resets(requested_at);
CREATE TABLE operator_password_reset_limits (
  key_hash text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  requests integer NOT NULL
);
CREATE INDEX operator_password_reset_limits_age ON operator_password_reset_limits(started_at);
