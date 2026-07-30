CREATE TABLE IF NOT EXISTS scm_schedule_user_preferences (
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  surface text NOT NULL,
  order_kind text NOT NULL DEFAULT '',
  method text NOT NULL DEFAULT '',
  statuses text[] NOT NULL DEFAULT '{}'::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, surface),
  CONSTRAINT scm_schedule_user_preferences_surface_check
    CHECK (surface IN ('scm', 'dispatch', 'sales')),
  CONSTRAINT scm_schedule_user_preferences_kind_check
    CHECK (order_kind IN ('', 'PO', 'TO', 'VRMA')),
  CONSTRAINT scm_schedule_user_preferences_method_check
    CHECK (method IN ('', 'MBT', 'Vendor', 'Customer Pickup')),
  CONSTRAINT scm_schedule_user_preferences_statuses_check
    CHECK (statuses <@ ARRAY[
      'Queued',
      'Planned',
      'Partially Done',
      'In Transit',
      'Completed',
      'Reconcile Review',
      'Urgent',
      'Cancelled',
      'Hold',
      'Priority',
      'Surplus Only',
      'Book Appt'
    ]::text[])
);

COMMENT ON TABLE scm_schedule_user_preferences IS
  'Per-operator PO/TO Schedule Type, Method, and Status filters, isolated by SCM, Dispatch, or Sales surface.';
