CREATE TABLE operator_posting_photo_uploads (
  id bigserial PRIMARY KEY,
  command_id uuid REFERENCES operator_netsuite_posting_commands(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES operator_consolidated_loads(id) ON DELETE CASCADE,
  photo_index integer NOT NULL CHECK (photo_index >= 0),
  photo_identity text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','uploaded')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  r2_ref text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  CHECK (num_nonnulls(command_id,batch_id)=1),
  CHECK ((status='uploading') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status='uploaded') = (r2_ref IS NOT NULL AND uploaded_at IS NOT NULL)),
  UNIQUE (command_id,photo_index),
  UNIQUE (batch_id,photo_index)
);
CREATE INDEX operator_posting_photo_uploads_pending_idx
  ON operator_posting_photo_uploads(next_attempt_at,id) WHERE status<>'uploaded';
ALTER TABLE operator_consolidated_loads ADD COLUMN photo_input_hash text;
