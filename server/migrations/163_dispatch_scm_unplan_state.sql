ALTER TABLE scm_transport_schedule
  ADD COLUMN IF NOT EXISTS dispatch_plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_previous_state jsonb;

COMMENT ON COLUMN scm_transport_schedule.dispatch_plan_id IS
  'Dispatch plan currently supplying the system-managed Planned assignment.';
COMMENT ON COLUMN scm_transport_schedule.dispatch_previous_state IS
  'Schedule status and assignment fields captured before Dispatch changed the row to Planned.';

CREATE INDEX IF NOT EXISTS idx_scm_transport_schedule_dispatch_plan
  ON scm_transport_schedule (dispatch_plan_id)
  WHERE dispatch_plan_id IS NOT NULL;

-- Attach legacy Planned rows that still have a real drop assignment to their
-- latest plan. Their exact pre-plan status was not retained by older releases,
-- so use the PO intake status (or Queued) as the safe restoration state.
WITH active_assignments AS MATERIALIZED (
  SELECT DISTINCT ON (
           CASE WHEN order_row.value->>'type' = 'TO' THEN 'TO' ELSE 'PO' END,
           lower(order_row.value->>'id')
         )
         p.id AS plan_id,
         CASE WHEN order_row.value->>'type' = 'TO' THEN 'TO' ELSE 'PO' END AS order_kind,
         order_row.value->>'id' AS order_ref
    FROM dispatch_plans p
    JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = p.id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb)) order_row(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value->'loads', '[]'::jsonb)) load(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value->'stops', '[]'::jsonb)) stop(value)
   WHERE p.status <> 'cancelled'
     AND order_row.value->>'type' IN ('PO', 'TO')
     AND lower(stop.value->>'orderId') = lower(order_row.value->>'id')
     AND stop.value->>'type' IN ('drop', 'dropoff')
     AND COALESCE(load.value->>'returnOnly', 'false') <> 'true'
   ORDER BY CASE WHEN order_row.value->>'type' = 'TO' THEN 'TO' ELSE 'PO' END,
            lower(order_row.value->>'id'), p.plan_date DESC, p.id DESC
)
UPDATE scm_transport_schedule schedule
   SET dispatch_plan_id = active.plan_id,
       dispatch_previous_state = COALESCE(
         schedule.dispatch_previous_state,
         jsonb_build_object(
           'status',
           CASE
             WHEN schedule.order_kind = 'PO' THEN COALESCE(
               (
                 SELECT NULLIF(po.initial_scm_status, '')
                   FROM purchase_orders po
                  WHERE lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower(schedule.order_ref)
                  ORDER BY po.netsuite_active DESC, po.synced_at DESC NULLS LAST
                  LIMIT 1
               ),
               'Queued'
             )
             ELSE 'Queued'
           END
         )
       )
  FROM active_assignments active
 WHERE schedule.order_kind = active.order_kind
   AND lower(schedule.order_ref) = lower(active.order_ref)
   AND schedule.status = 'Planned'
   AND (
     NULLIF(schedule.dispatch_assignment_note, '') IS NOT NULL
     OR COALESCE(schedule.updated_by, '') LIKE 'dispatch-v2:%'
     OR COALESCE(schedule.created_by, '') LIKE 'dispatch-v2:%'
   );

-- Repair rows such as SN1398121: Dispatch removed the stop, but the old sync
-- only upserted current assignments and never reverted a stale Planned row.
WITH active_assignments AS MATERIALIZED (
  SELECT CASE WHEN order_row.value->>'type' = 'TO' THEN 'TO' ELSE 'PO' END AS order_kind,
         order_row.value->>'id' AS order_ref
    FROM dispatch_plans p
    JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = p.id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb)) order_row(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value->'loads', '[]'::jsonb)) load(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value->'stops', '[]'::jsonb)) stop(value)
   WHERE p.status <> 'cancelled'
     AND order_row.value->>'type' IN ('PO', 'TO')
     AND lower(stop.value->>'orderId') = lower(order_row.value->>'id')
     AND stop.value->>'type' IN ('drop', 'dropoff')
     AND COALESCE(load.value->>'returnOnly', 'false') <> 'true'
)
UPDATE scm_transport_schedule schedule
   SET status = COALESCE(
         NULLIF(schedule.dispatch_previous_state->>'status', ''),
         CASE
           WHEN schedule.order_kind = 'PO' THEN COALESCE(
             (
               SELECT NULLIF(po.initial_scm_status, '')
                 FROM purchase_orders po
                WHERE lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower(schedule.order_ref)
                ORDER BY po.netsuite_active DESC, po.synced_at DESC NULLS LAST
                LIMIT 1
             ),
             'Queued'
           )
           ELSE 'Queued'
         END
       ),
       eta_date = NULLIF(schedule.dispatch_previous_state->>'etaDate', '')::date,
       eta_time = NULLIF(schedule.dispatch_previous_state->>'etaTime', ''),
       driver = NULLIF(schedule.dispatch_previous_state->>'driver', ''),
       dispatch_assignment_note = NULLIF(schedule.dispatch_previous_state->>'dispatchAssignmentNote', ''),
       dispatch_plan_id = NULL,
       dispatch_previous_state = NULL,
       updated_by = 'migration-163-dispatch-unplan',
       updated_at = now()
 WHERE schedule.order_kind IN ('PO', 'TO')
   AND schedule.status = 'Planned'
   AND (
     NULLIF(schedule.dispatch_assignment_note, '') IS NOT NULL
     OR COALESCE(schedule.updated_by, '') LIKE 'dispatch-v2:%'
     OR COALESCE(schedule.created_by, '') LIKE 'dispatch-v2:%'
   )
   AND NOT EXISTS (
     SELECT 1
       FROM active_assignments active
      WHERE active.order_kind = schedule.order_kind
        AND lower(active.order_ref) = lower(schedule.order_ref)
   );
