-- Direct ship is derived from active PO/TO links. Allow it in saved filters
-- without changing any order statuses or existing preference selections.
ALTER TABLE scm_schedule_user_preferences
  DROP CONSTRAINT IF EXISTS scm_schedule_user_preferences_statuses_check;

ALTER TABLE scm_schedule_user_preferences
  ADD CONSTRAINT scm_schedule_user_preferences_statuses_check
  CHECK (statuses <@ ARRAY[
    'Queued', 'Planned', 'Direct ship', 'Partially Done', 'In Transit',
    'Completed', 'Reconcile Review', 'Urgent', 'Cancelled', 'Hold',
    'Priority', 'Surplus Only', 'Book Appt'
  ]::text[]);
