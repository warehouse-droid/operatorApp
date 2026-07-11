CREATE TABLE IF NOT EXISTS dispatch_local_vendors (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_local_vendors_name
  ON dispatch_local_vendors (LOWER(name));

INSERT INTO dispatch_local_vendors (name)
SELECT DISTINCT vendor
  FROM dispatch_vendor_yards
 WHERE COALESCE(vendor, '') <> ''
ON CONFLICT (LOWER(name)) DO NOTHING;

INSERT INTO dispatch_local_vendors (name)
SELECT DISTINCT local_vendor
  FROM dispatch_vendor_mappings
 WHERE COALESCE(local_vendor, '') <> ''
ON CONFLICT (LOWER(name)) DO NOTHING;
