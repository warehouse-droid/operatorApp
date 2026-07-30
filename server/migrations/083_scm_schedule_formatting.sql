CREATE TABLE IF NOT EXISTS scm_schedule_formatting_settings (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_schedule_formatting_settings_singleton_check
    CHECK (singleton_id = 1),
  CONSTRAINT scm_schedule_formatting_settings_rules_object_check
    CHECK (jsonb_typeof(rules) = 'object')
);

INSERT INTO scm_schedule_formatting_settings (singleton_id)
VALUES (1)
ON CONFLICT (singleton_id) DO NOTHING;

COMMENT ON TABLE scm_schedule_formatting_settings IS
  'Company-wide, SCM-managed cell and whole-row formatting rules for the PO/TO Schedule.';
