ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_role_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_role_check
  CHECK (role IN ('operator', 'dispatcher', 'admin', 'scm', 'yard_manager'));

UPDATE scm_view_presets
   SET description = 'Completed shipments.',
       config = jsonb_set(config, '{filters,statuses}', '["Completed"]'::jsonb, true),
       updated_at = now()
 WHERE lower(name) = 'completed';
