BEGIN;

-- assignments_ready is a safety gate, not a historical health signal. Any
-- plan lifecycle or revision writer, including future SQL that bypasses the
-- repositories, must invalidate it in the same transaction as the write.
CREATE OR REPLACE FUNCTION public.invalidate_dispatch_assignment_projection_readiness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.dispatch_order_catalog_state
     SET assignments_ready = false,
         updated_at = now()
   WHERE singleton = true;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispatch_plans_invalidate_assignment_projection
  ON public.dispatch_plans;

CREATE TRIGGER trg_dispatch_plans_invalidate_assignment_projection
AFTER INSERT OR DELETE OR UPDATE OF revision, status
ON public.dispatch_plans
FOR EACH STATEMENT
EXECUTE FUNCTION public.invalidate_dispatch_assignment_projection_readiness();

-- Force one verified projection pass after cutover before the optimized pool
-- can claim that cross-date assignment evidence is current.
UPDATE public.dispatch_order_catalog_state
   SET assignments_ready = false,
       updated_at = now()
 WHERE singleton = true;

COMMIT;
