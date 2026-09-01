BEGIN;

-- A local CO is a physical yard-transfer leg. Driver PWA records its terminal
-- drop under CO_ORDER/CO, which is intentionally not a billable universal
-- Dispatch order kind. Project that evidence into the local CO lifecycle so
-- the completed transfer leaves the planning pool while its source order can
-- continue from the destination yard.
CREATE OR REPLACE FUNCTION dispatch_project_driver_co_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF lower(btrim(COALESCE(NEW.status, ''))) NOT IN ('complete', 'completed')
     OR lower(btrim(COALESCE(NEW.stop_type, ''))) <> 'dropoff'
     OR NEW.completed_at IS NULL
     OR jsonb_typeof(COALESCE(NEW.order_refs, '[]'::jsonb)) <> 'array' THEN
    RETURN NEW;
  END IF;

  UPDATE local_co_orders co
     SET status = 'completed',
         updated_at = clock_timestamp(),
         details = COALESCE(co.details, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'driverCompletionSource', 'driver_pwa',
           'driverCompletionRecordId', NEW.id,
           'driverCompletionJobId', NEW.job_id,
           'driverCompletedAt', NEW.completed_at,
           'driverCompletionPlanId', NEW.plan_id,
           'driverCompletionPlanDate', NEW.plan_date,
           'driverCompletionLoadId', NULLIF(btrim(COALESCE(NEW.load_id, '')), ''),
           'driverCompletionLoadName', NULLIF(btrim(COALESCE(NEW.load_name, '')), ''),
           'driverCompletionStopId', NULLIF(btrim(COALESCE(NEW.stop_id, '')), ''),
           'driverCompletionTruckPlate', NULLIF(btrim(COALESCE(NEW.truck_plate, '')), ''),
           'driverCompletionDriver', NULLIF(btrim(COALESCE(NEW.driver_login, '')), ''),
           'completedAfterCancellation', lower(btrim(COALESCE(co.status, ''))) = 'cancelled'
         ))
    FROM (
      SELECT DISTINCT lower(btrim(reference.value)) AS co_ref
        FROM jsonb_array_elements_text(NEW.order_refs) reference(value)
       WHERE NULLIF(btrim(reference.value), '') IS NOT NULL
    ) completed_ref
   WHERE lower(btrim(co.co_ref)) = completed_ref.co_ref
     AND (
       lower(btrim(COALESCE(co.status, ''))) <> 'completed'
       OR NULLIF(btrim(COALESCE(co.details->>'driverCompletionJobId', '')), '') IS NULL
     )
     AND (
       lower(btrim(COALESCE(co.status, ''))) <> 'cancelled'
       OR NEW.completed_at >= COALESCE(co.updated_at, co.created_at)
     );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_driver_job_local_co_completion ON driver_job_records;
CREATE TRIGGER trg_driver_job_local_co_completion
  AFTER INSERT OR UPDATE OF status, completed_at, stop_type, order_refs
  ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_driver_co_completion();

-- Repair historical rows with the earliest eligible terminal drop. A later
-- cancellation remains authoritative; an earlier cancellation cannot erase a
-- physical completion that happened afterward.
WITH completed_co_candidates AS (
  SELECT co.id AS co_id,
         co.status AS prior_status,
         record.id AS driver_record_id,
         record.job_id,
         record.completed_at,
         record.plan_id,
         record.plan_date,
         record.load_id,
         record.load_name,
         record.stop_id,
         record.truck_plate,
         record.driver_login,
         row_number() OVER (
           PARTITION BY co.id
           ORDER BY record.completed_at, record.id
         ) AS completion_rank
    FROM local_co_orders co
    JOIN driver_job_records record
      ON lower(btrim(COALESCE(record.status, ''))) IN ('complete', 'completed')
     AND lower(btrim(COALESCE(record.stop_type, ''))) = 'dropoff'
     AND record.completed_at IS NOT NULL
     AND jsonb_typeof(COALESCE(record.order_refs, '[]'::jsonb)) = 'array'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(record.order_refs) reference(value)
        WHERE lower(btrim(reference.value)) = lower(btrim(co.co_ref))
     )
   WHERE lower(btrim(COALESCE(co.status, ''))) <> 'completed'
     AND (
       lower(btrim(COALESCE(co.status, ''))) <> 'cancelled'
       OR record.completed_at >= COALESCE(co.updated_at, co.created_at)
     )
), retained_completion AS (
  SELECT *
    FROM completed_co_candidates
   WHERE completion_rank = 1
)
UPDATE local_co_orders co
   SET status = 'completed',
       updated_at = clock_timestamp(),
       details = COALESCE(co.details, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
         'driverCompletionSource', 'driver_pwa',
         'driverCompletionRecordId', retained.driver_record_id,
         'driverCompletionJobId', retained.job_id,
         'driverCompletedAt', retained.completed_at,
         'driverCompletionPlanId', retained.plan_id,
         'driverCompletionPlanDate', retained.plan_date,
         'driverCompletionLoadId', NULLIF(btrim(COALESCE(retained.load_id, '')), ''),
         'driverCompletionLoadName', NULLIF(btrim(COALESCE(retained.load_name, '')), ''),
         'driverCompletionStopId', NULLIF(btrim(COALESCE(retained.stop_id, '')), ''),
         'driverCompletionTruckPlate', NULLIF(btrim(COALESCE(retained.truck_plate, '')), ''),
         'driverCompletionDriver', NULLIF(btrim(COALESCE(retained.driver_login, '')), ''),
         'completedAfterCancellation', lower(btrim(COALESCE(retained.prior_status, ''))) = 'cancelled'
       ))
  FROM retained_completion retained
 WHERE co.id = retained.co_id;

COMMIT;
