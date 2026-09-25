CREATE TABLE IF NOT EXISTS operator_ui_preferences (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preferences) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
