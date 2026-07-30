ALTER TABLE scm_schedule_user_preferences
  DROP CONSTRAINT IF EXISTS scm_schedule_user_preferences_kind_check;

ALTER TABLE scm_schedule_user_preferences
  ADD CONSTRAINT scm_schedule_user_preferences_kind_check
  CHECK (order_kind IN ('', 'PO', 'Sp.O', 'TO', 'VRMA'));

COMMENT ON COLUMN scm_schedule_user_preferences.order_kind IS
  'Per-user Type filter. Sp.O selects purchase orders explicitly marked as special orders.';
