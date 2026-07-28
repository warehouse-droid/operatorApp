CREATE TABLE IF NOT EXISTS sales_portal_settings (
  id smallint PRIMARY KEY DEFAULT 1,
  public_access_enabled boolean,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_portal_settings_singleton CHECK (id = 1)
);

INSERT INTO sales_portal_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN sales_portal_settings.public_access_enabled IS
  'NULL only during migration; the application initializes it once from the legacy environment value.';
