CREATE INDEX IF NOT EXISTS idx_operator_load_records_movement_activity
  ON operator_load_records (created_at DESC, order_family, load_type, order_id);

CREATE INDEX IF NOT EXISTS idx_receiving_receipt_records_movement_activity
  ON receiving_receipt_records (created_at DESC, receipt_status, order_id);

CREATE INDEX IF NOT EXISTS idx_local_co_receipt_records_movement_activity
  ON local_co_receipt_records (created_at DESC, co_id);

CREATE INDEX IF NOT EXISTS idx_driver_job_records_movement_activity
  ON driver_job_records ((
    CASE
      WHEN status = 'complete' THEN COALESCE(completed_at, started_at, created_at)
      ELSE COALESCE(started_at, created_at)
    END
  ) DESC, driver_login)
  WHERE stop_type IN ('pickup', 'dropoff')
    AND status IN ('in_progress', 'complete');
