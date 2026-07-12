ALTER TABLE driver_day_records
  ADD COLUMN IF NOT EXISTS samsara_active_account text NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS samsara_secondary_username text,
  ADD COLUMN IF NOT EXISTS samsara_secondary_driver_id text,
  ADD COLUMN IF NOT EXISTS samsara_secondary_vehicle_id text,
  ADD COLUMN IF NOT EXISTS samsara_secondary_assignment_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS samsara_secondary_on_duty_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS samsara_secondary_off_duty_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS samsara_handoff_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS primary_off_duty_at timestamptz,
  ADD COLUMN IF NOT EXISTS secondary_on_duty_at timestamptz,
  ADD COLUMN IF NOT EXISTS secondary_off_duty_at timestamptz;

UPDATE driver_day_records
   SET samsara_active_account = COALESCE(NULLIF(samsara_active_account, ''), 'primary')
 WHERE samsara_active_account IS NULL
    OR samsara_active_account = '';
