CREATE TABLE IF NOT EXISTS google_maps_daily_reopens (
  id uuid PRIMARY KEY,
  day date NOT NULL,
  added_units integer NOT NULL CHECK (added_units > 0 AND added_units <= 4500),
  actor_id text NOT NULL CHECK (actor_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS google_maps_daily_reopens_day_idx
  ON google_maps_daily_reopens (day);
