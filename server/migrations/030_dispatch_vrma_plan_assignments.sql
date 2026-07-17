CREATE TABLE IF NOT EXISTS dispatch_vrma_plan_assignments (
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  order_ref text NOT NULL,
  plan_date date NOT NULL,
  truck_plate text,
  driver text,
  load_name text,
  parking_spot text,
  eta_time text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, order_ref)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_vrma_plan_assignments_ref
  ON dispatch_vrma_plan_assignments (lower(order_ref), plan_date DESC);

INSERT INTO dispatch_vrma_plan_assignments (
  plan_id, order_ref, plan_date, truck_plate, driver, load_name, parking_spot, eta_time, updated_at
)
SELECT DISTINCT ON (p.id, stop.value->>'orderId')
       p.id,
       stop.value->>'orderId',
       p.plan_date,
       NULLIF(truck.value->>'plate', ''),
       COALESCE(NULLIF(truck.value->>'driverName', ''), NULLIF(truck.value->>'driver', '')),
       NULLIF(load.value->>'name', ''),
       COALESCE(NULLIF(load.value->>'parkingSpot', ''), NULLIF(truck.value->>'parkingSpot', '')),
       COALESCE(NULLIF(stop.value->>'arriveTime', ''), NULLIF(stop.value->>'plannedArrive', '')),
       p.updated_at
  FROM dispatch_plans p
  JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = p.id
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck(value)
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value->'loads', '[]'::jsonb)) load(value)
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value->'stops', '[]'::jsonb)) stop(value)
 WHERE p.status <> 'cancelled'
   AND snapshot.orders @> '[{"sourceTable":"scm_vrma_orders"}]'::jsonb
   AND stop.value->>'type' = 'drop'
   AND COALESCE(load.value->>'returnOnly', 'false') <> 'true'
   AND EXISTS (
     SELECT 1
       FROM jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb)) plan_order(value)
      WHERE plan_order.value->>'id' = stop.value->>'orderId'
        AND plan_order.value->>'sourceTable' = 'scm_vrma_orders'
   )
 ORDER BY p.id, stop.value->>'orderId'
ON CONFLICT (plan_id, order_ref) DO UPDATE SET
  plan_date = EXCLUDED.plan_date,
  truck_plate = EXCLUDED.truck_plate,
  driver = EXCLUDED.driver,
  load_name = EXCLUDED.load_name,
  parking_spot = EXCLUDED.parking_spot,
  eta_time = EXCLUDED.eta_time,
  updated_at = EXCLUDED.updated_at;

COMMENT ON TABLE dispatch_vrma_plan_assignments IS
  'Normalized current dispatch assignments for local VRMA orders; avoids reparsing dispatch snapshot JSON on every VRMA request.';
