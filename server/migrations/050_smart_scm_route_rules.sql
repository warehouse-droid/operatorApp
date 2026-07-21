CREATE TABLE IF NOT EXISTS scm_smart_route_rules (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  source_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  max_drops integer NOT NULL DEFAULT 2 CHECK (max_drops BETWEEN 1 AND 2),
  stop_order jsonb NOT NULL DEFAULT '[26,15,1,28]'::jsonb,
  partial_redirect_enabled boolean NOT NULL DEFAULT false,
  partial_redirect_destination_ids jsonb NOT NULL DEFAULT '[1,28]'::jsonb,
  partial_redirect_hub_location_id bigint,
  notes text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO scm_smart_route_rules (
  source_key, source_name, enabled, max_drops, stop_order,
  partial_redirect_enabled, partial_redirect_destination_ids,
  partial_redirect_hub_location_id, notes
) VALUES
  ('gormley', 'Gormley', true, 2, '[15,1,28,26]'::jsonb, true, '[1,28]'::jsonb, 15,
   'Partial direct-shop quantities route through 12441. Direct shop delivery is allowed only when that shop quantity is operationally full by itself.'),
  ('uxbridge', 'Uxbridge', true, 2, '[15,1,28,26]'::jsonb, false, '[1,28]'::jsonb, NULL,
   'Do not use 150 as the first stop when another yard is on the route.'),
  ('woodbridge', 'Woodbridge', true, 2, '[15,1,28,26]'::jsonb, false, '[1,28]'::jsonb, NULL,
   'Do not use 150 as the first stop when another yard is on the route.')
ON CONFLICT (source_key) DO NOTHING;

COMMENT ON TABLE scm_smart_route_rules IS
  'Source-specific Smart SCM PO routing rules. Changes affect future planning and PO recalculation only.';
