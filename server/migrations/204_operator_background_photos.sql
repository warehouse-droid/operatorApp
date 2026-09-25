CREATE TABLE operator_photo_actions (
  id uuid PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id),
  location_id bigint NOT NULL,
  function_key text NOT NULL,
  order_id text NOT NULL,
  order_type text NOT NULL DEFAULT '',
  input_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT 'null'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operator_background_photos (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES operator_photo_actions(id),
  photo_index integer NOT NULL CHECK (photo_index >= 0 AND photo_index < 20),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/heic','image/heif')),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','pending','uploading','uploaded')),
  bytes bytea,
  r2_ref text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  received_at timestamptz,
  uploaded_at timestamptz,
  CHECK ((status IN ('pending','uploading')) = (bytes IS NOT NULL)),
  CHECK (bytes IS NULL OR octet_length(bytes)=byte_size),
  CHECK ((status='uploading') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status='uploaded') = (r2_ref IS NOT NULL AND uploaded_at IS NOT NULL)),
  UNIQUE(action_id,photo_index)
);
CREATE INDEX operator_background_photos_pending_idx ON operator_background_photos(next_attempt_at,id)
  WHERE status IN ('pending','uploading');
