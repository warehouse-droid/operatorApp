CREATE TABLE IF NOT EXISTS dispatch_vendor_mappings (
  id bigserial PRIMARY KEY,
  netsuite_vendor_id text NOT NULL DEFAULT '',
  netsuite_vendor_name text NOT NULL,
  local_vendor text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  last_po_ref text NOT NULL DEFAULT '',
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_vendor_mappings_vendor_key
  ON dispatch_vendor_mappings (LOWER(COALESCE(NULLIF(netsuite_vendor_id, ''), netsuite_vendor_name)));

CREATE INDEX IF NOT EXISTS idx_dispatch_vendor_mappings_local_vendor
  ON dispatch_vendor_mappings (local_vendor);
