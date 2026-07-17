CREATE TABLE IF NOT EXISTS photo_archive_settings (
  id smallint PRIMARY KEY DEFAULT 1,
  mode text NOT NULL DEFAULT 'off',
  interval_minutes integer NOT NULL DEFAULT 1440,
  running boolean NOT NULL DEFAULT false,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text NOT NULL DEFAULT 'idle',
  last_source text,
  last_error text,
  last_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT photo_archive_settings_singleton CHECK (id = 1),
  CONSTRAINT photo_archive_settings_mode CHECK (mode IN ('off', 'manual', 'auto')),
  CONSTRAINT photo_archive_settings_interval CHECK (interval_minutes BETWEEN 5 AND 43200)
);

INSERT INTO photo_archive_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS photo_archive_objects (
  r2_key text PRIMARY KEY,
  local_path text NOT NULL UNIQUE,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  etag text,
  archived_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  r2_deleted_at timestamptz,
  delete_attempts integer NOT NULL DEFAULT 0,
  last_delete_error text,
  last_delete_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT photo_archive_objects_size CHECK (byte_size >= 0)
);

CREATE INDEX IF NOT EXISTS idx_photo_archive_objects_remote
  ON photo_archive_objects (r2_deleted_at, archived_at);
