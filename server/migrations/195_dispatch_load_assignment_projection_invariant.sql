CREATE OR REPLACE FUNCTION invalidate_dispatch_snapshot_assignment_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM dispatch_plan_projection_state
   WHERE plan_id = NEW.plan_id;

  UPDATE dispatch_order_catalog_state
     SET assignments_ready = false,
         updated_at = now()
   WHERE singleton = true;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispatch_snapshot_insert_invalidate_assignment_projection
  ON dispatch_plan_snapshots;

CREATE TRIGGER trg_dispatch_snapshot_insert_invalidate_assignment_projection
AFTER INSERT ON dispatch_plan_snapshots
FOR EACH ROW
EXECUTE FUNCTION invalidate_dispatch_snapshot_assignment_projection();

DROP TRIGGER IF EXISTS trg_dispatch_snapshot_update_invalidate_assignment_projection
  ON dispatch_plan_snapshots;

CREATE TRIGGER trg_dispatch_snapshot_update_invalidate_assignment_projection
AFTER UPDATE OF orders, trucks ON dispatch_plan_snapshots
FOR EACH ROW
WHEN (OLD.orders IS DISTINCT FROM NEW.orders OR OLD.trucks IS DISTINCT FROM NEW.trucks)
EXECUTE FUNCTION invalidate_dispatch_snapshot_assignment_projection();

-- Earlier V2 writers refreshed the order projection but could leave the load
-- projection at an older route. Mark every active V2 snapshot for the normal,
-- idempotent startup backfill so both projections are rebuilt together.
DELETE FROM dispatch_plan_projection_state projection
USING dispatch_plans plan, dispatch_plan_snapshots snapshot
WHERE projection.plan_id = plan.id
  AND snapshot.plan_id = plan.id
  AND plan.status <> 'cancelled'
  AND snapshot.schema_version >= 2;

UPDATE dispatch_order_catalog_state
   SET assignments_ready = false,
       updated_at = now()
 WHERE singleton = true;
