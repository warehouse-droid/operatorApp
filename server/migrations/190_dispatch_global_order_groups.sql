-- A Dispatch delivery-group definition is global. Its route assignment remains
-- plan-specific in dispatch_plan_order_assignments / dispatch_delivery_groups.
CREATE TABLE IF NOT EXISTS dispatch_global_order_groups (
  group_ref text PRIMARY KEY,
  order_type text NOT NULL CHECK (order_type IN ('SO', 'TO')),
  source_plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  source_plan_date date NOT NULL,
  full_order jsonb NOT NULL,
  card jsonb NOT NULL,
  search_text text NOT NULL DEFAULT '',
  eligible boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  source_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_global_order_group_ref_not_blank
    CHECK (NULLIF(btrim(group_ref), '') IS NOT NULL),
  CONSTRAINT dispatch_global_order_group_documents
    CHECK (jsonb_typeof(full_order) = 'object' AND jsonb_typeof(card) = 'object'),
  CONSTRAINT dispatch_global_order_group_revision_nonnegative
    CHECK (source_revision >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_global_order_groups_ref_ci
  ON dispatch_global_order_groups (lower(group_ref));
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_groups_pool
  ON dispatch_global_order_groups (active, eligible, order_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_groups_source_plan
  ON dispatch_global_order_groups (source_plan_id, active);
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_groups_search
  ON dispatch_global_order_groups USING gin (search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS dispatch_global_order_group_members (
  group_ref text NOT NULL REFERENCES dispatch_global_order_groups(group_ref) ON DELETE CASCADE,
  member_order_ref text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_ref, member_order_ref),
  UNIQUE (group_ref, position)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_group_members_ref
  ON dispatch_global_order_group_members (lower(member_order_ref), group_ref);

-- Backfill canonical definitions from the current snapshot of their owning
-- plan. A copied foreign-plan snapshot is deliberately excluded.
WITH candidates AS (
  SELECT DISTINCT ON (lower(candidate.order_json ->> 'id'))
         candidate.order_json ->> 'id' AS group_ref,
         upper(candidate.order_json ->> 'type') AS order_type,
         plan.id AS source_plan_id,
         plan.plan_date AS source_plan_date,
         plan.revision AS source_revision,
         candidate.order_json,
         plan.updated_at
    FROM dispatch_plans plan
    JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb))
      AS candidate(order_json)
   WHERE plan.status <> 'cancelled'
     AND upper(COALESCE(candidate.order_json ->> 'type', '')) IN ('SO', 'TO')
     AND jsonb_typeof(candidate.order_json -> 'childOrders') = 'array'
     AND jsonb_array_length(candidate.order_json -> 'childOrders') > 0
     AND COALESCE(NULLIF(candidate.order_json ->> 'groupPlanId', ''), plan.id::text) = plan.id::text
     AND COALESCE(NULLIF(left(candidate.order_json ->> 'groupPlanDate', 10), ''), plan.plan_date::text) = plan.plan_date::text
   ORDER BY lower(candidate.order_json ->> 'id'), plan.updated_at DESC, plan.id DESC
), inserted AS (
  INSERT INTO dispatch_global_order_groups (
    group_ref, order_type, source_plan_id, source_plan_date, full_order, card,
    search_text, eligible, active, source_revision, updated_at
  )
  SELECT group_ref,
         order_type,
         source_plan_id,
         source_plan_date,
         (
           order_json
           - 'dispatchSnapshotSourcePlanId'
           - 'dispatchSnapshotSourcePlanDate'
           - 'dispatchPlanned'
           - 'dispatchPlanId'
           - 'dispatchPlanDate'
           - 'dispatchTruckPlate'
           - 'dispatchLoadName'
           - 'dispatchParkingSpot'
           - 'dispatchDriverLogin'
           - 'dispatchDriverName'
           - 'jump'
           - 'readOnly'
           - 'assigned'
           - 'groupPlanId'
           - 'groupPlanDate'
           - 'planOwned'
         ) || jsonb_build_object(
           'globalGroupDefinition', true,
           'globalGroupSourcePlanId', source_plan_id::text,
           'globalGroupSourcePlanDate', source_plan_date::text,
           'groupPlanId', '',
           'groupPlanDate', '',
           'planOwned', false,
           'dispatchPlanned', false,
           'catalogHydrated', true
         ),
         (
           order_json
           - 'childOrderDetails'
           - 'items'
           - 'dispatchSnapshotSourcePlanId'
           - 'dispatchSnapshotSourcePlanDate'
           - 'groupPlanId'
           - 'groupPlanDate'
         ) || jsonb_build_object(
           'globalGroupDefinition', true,
           'globalGroupSourcePlanId', source_plan_id::text,
           'globalGroupSourcePlanDate', source_plan_date::text,
           'groupPlanId', '',
           'groupPlanDate', '',
           'planOwned', false,
           'catalogHydrated', false
         ),
         lower(concat_ws(' ', group_ref, order_json::text)),
         true,
         true,
         source_revision,
         updated_at
    FROM candidates
  ON CONFLICT DO NOTHING
  RETURNING group_ref, full_order
)
INSERT INTO dispatch_global_order_group_members (group_ref, member_order_ref, position)
SELECT inserted.group_ref, member.value, member.ordinality::integer - 1
  FROM inserted
  CROSS JOIN LATERAL jsonb_array_elements_text(inserted.full_order -> 'childOrders')
    WITH ORDINALITY AS member(value, ordinality)
ON CONFLICT (group_ref, member_order_ref) DO NOTHING;
