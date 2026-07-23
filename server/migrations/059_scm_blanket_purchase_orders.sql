ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS initial_scm_status text,
  ADD COLUMN IF NOT EXISTS is_blanket_po boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blanket_flagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS blanket_flagged_by text;

UPDATE purchase_orders
   SET initial_scm_status = 'Queued'
 WHERE initial_scm_status IS NULL;

ALTER TABLE purchase_orders
  ALTER COLUMN initial_scm_status SET DEFAULT 'Queued',
  ALTER COLUMN initial_scm_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'purchase_orders_initial_scm_status_check'
       AND conrelid = 'purchase_orders'::regclass
  ) THEN
    ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_initial_scm_status_check
      CHECK (initial_scm_status IN ('Queued', 'Hold'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_blanket
  ON purchase_orders (netsuite_id)
  WHERE is_blanket_po = true;

INSERT INTO scm_view_presets (name, description, config)
VALUES (
  'Blanket',
  'Review purchase orders and flag large blanket parents so they stay out of normal schedules and dispatch planning.',
  '{"filters":{"kind":"PO","blanketManagement":true},"columns":["orderRef","orderKind","blanket","pickupPoint","dropoffPoint","brand","content","weightLbs","eta","status"]}'::jsonb
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    config = EXCLUDED.config,
    active = true,
    updated_at = now();
