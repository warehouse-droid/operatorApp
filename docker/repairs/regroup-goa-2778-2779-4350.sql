BEGIN;

CREATE TEMP TABLE regroup_targets ON COMMIT DROP AS
SELECT
  p.id AS plan_id,
  p.plan_date,
  p.revision,
  s.orders,
  s.trucks,
  s.summary,
  s.saved_at
FROM dispatch_plans p
JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
WHERE p.id IN (44, 45)
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(s.orders) order_item
    WHERE order_item->>'id' = 'GOA-2778-2779'
  );

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM regroup_targets) <> 2 THEN
    RAISE EXCEPTION 'Expected Jul-12 and Jul-13 nested group snapshots; repair stopped.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM regroup_targets target
    CROSS JOIN LATERAL jsonb_array_elements(target.orders) order_item
    WHERE order_item->>'id' = 'GOA-2778-2779-4350'
  ) THEN
    RAISE EXCEPTION 'GOA-2778-2779-4350 already exists; repair stopped.';
  END IF;
END $$;

INSERT INTO dispatch_plan_snapshot_history (
  plan_id,
  plan_date,
  revision,
  orders,
  trucks,
  summary,
  original_saved_at,
  archive_reason,
  session_id
)
SELECT
  plan_id,
  plan_date,
  revision,
  orders,
  trucks,
  summary,
  saved_at,
  'before_group_regroup',
  'codex-local-repair'
FROM regroup_targets;

WITH rebuilt_orders AS (
  SELECT
    target.plan_id,
    jsonb_agg(
      CASE
        WHEN order_item.value->>'id' = 'GOA-2778-2779' THEN
          order_item.value || jsonb_build_object(
            'id', 'GOA-2778-2779-4350',
            'customer', '3 orders grouped',
            'groupKey', 'GOA-2778-2779-4350',
            'childOrders', to_jsonb(ARRAY['SOA02778', 'SOA02779', 'SOA04350']::text[]),
            'childOrderDetails', (
              SELECT jsonb_agg(
                leaf.value || jsonb_build_object(
                  'childOrders', '[]'::jsonb,
                  'childOrderDetails', '[]'::jsonb
                )
                ORDER BY leaf.value->>'id'
              )
              FROM jsonb_array_elements(COALESCE(order_item.value->'childOrderDetails', '[]'::jsonb)) direct
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                  WHEN jsonb_array_length(COALESCE(direct.value->'childOrderDetails', '[]'::jsonb)) > 0
                    THEN direct.value->'childOrderDetails'
                  ELSE jsonb_build_array(direct.value)
                END
              ) leaf
              WHERE leaf.value->>'id' IN ('SOA02778', 'SOA02779', 'SOA04350')
            ),
            'groupAliases', to_jsonb(ARRAY['GOA-2778-2779', 'GOA-2779-4350']::text[]),
            'notes', 'Grouped orders: SOA02778, SOA02779, SOA04350',
            'plannedOrderRef', 'GOA-2778-2779-4350'
          )
        ELSE order_item.value
      END
      ORDER BY order_item.ordinality
    ) AS orders
  FROM regroup_targets target
  CROSS JOIN LATERAL jsonb_array_elements(target.orders) WITH ORDINALITY order_item(value, ordinality)
  GROUP BY target.plan_id
), rebuilt_trucks AS (
  SELECT
    target.plan_id,
    jsonb_agg(
      truck.value || jsonb_build_object(
        'loads', COALESCE((
          SELECT jsonb_agg(
            load.value || jsonb_build_object(
              'stops', COALESCE((
                SELECT jsonb_agg(
                  CASE
                    WHEN stop.value->>'orderId' = 'GOA-2778-2779' THEN
                      stop.value || jsonb_build_object('orderId', 'GOA-2778-2779-4350')
                    ELSE stop.value
                  END
                  ORDER BY stop.ordinality
                )
                FROM jsonb_array_elements(COALESCE(load.value->'stops', '[]'::jsonb))
                  WITH ORDINALITY stop(value, ordinality)
              ), '[]'::jsonb)
            )
            ORDER BY load.ordinality
          )
          FROM jsonb_array_elements(COALESCE(truck.value->'loads', '[]'::jsonb))
            WITH ORDINALITY load(value, ordinality)
        ), '[]'::jsonb)
      )
      ORDER BY truck.ordinality
    ) AS trucks
  FROM regroup_targets target
  CROSS JOIN LATERAL jsonb_array_elements(target.trucks) WITH ORDINALITY truck(value, ordinality)
  GROUP BY target.plan_id
)
UPDATE dispatch_plan_snapshots snapshot
SET
  orders = rebuilt_orders.orders,
  trucks = rebuilt_trucks.trucks,
  saved_at = now()
FROM rebuilt_orders
JOIN rebuilt_trucks USING (plan_id)
WHERE snapshot.plan_id = rebuilt_orders.plan_id;

UPDATE dispatch_plans plan
SET
  revision = plan.revision + 1,
  updated_at = now()
WHERE plan.id IN (SELECT plan_id FROM regroup_targets);

INSERT INTO dispatch_audit_log (
  action,
  entity_type,
  entity_id,
  order_id,
  session_id,
  operator_name,
  source,
  before_state,
  after_state,
  details,
  plan_id,
  plan_date
)
SELECT
  'dispatch.group.regroup_repair',
  'order',
  'GOA-2778-2779-4350',
  'GOA-2778-2779-4350',
  'codex-local-repair',
  'system',
  'dispatch',
  (
    SELECT order_item
    FROM jsonb_array_elements(target.orders) order_item
    WHERE order_item->>'id' = 'GOA-2778-2779'
    LIMIT 1
  ),
  (
    SELECT order_item
    FROM dispatch_plan_snapshots snapshot
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.orders) order_item
    WHERE snapshot.plan_id = target.plan_id
      AND order_item->>'id' = 'GOA-2778-2779-4350'
    LIMIT 1
  ),
  jsonb_build_object(
    'oldGroupIds', ARRAY['GOA-2778-2779', 'GOA-2779-4350'],
    'childOrderIds', ARRAY['SOA02778', 'SOA02779', 'SOA04350'],
    'preservedTransitCoId', 'CO-GOA-2779-4350',
    'previousRevision', target.revision,
    'newRevision', target.revision + 1
  ),
  target.plan_id,
  target.plan_date
FROM regroup_targets target;

COMMIT;
