-- Every Dispatch order definition is global. Plan/date ownership applies only
-- to assignments; it must never decide whether a split or group exists.

ALTER TABLE dispatch_global_order_groups
  DROP CONSTRAINT IF EXISTS dispatch_global_order_groups_order_type_check;

ALTER TABLE dispatch_global_order_groups
  ADD CONSTRAINT dispatch_global_order_groups_order_type_check
  CHECK (order_type IN ('SO', 'PO', 'TO', 'CO'));

-- The plan is provenance for a global definition, not its lifecycle owner.
-- Deleting a plan must not delete the order definition it happened to create.
ALTER TABLE dispatch_global_order_groups
  ALTER COLUMN source_plan_id DROP NOT NULL;

ALTER TABLE dispatch_global_order_groups
  DROP CONSTRAINT IF EXISTS dispatch_global_order_groups_source_plan_id_fkey;

ALTER TABLE dispatch_global_order_groups
  ADD CONSTRAINT dispatch_global_order_groups_source_plan_id_fkey
  FOREIGN KEY (source_plan_id) REFERENCES dispatch_plans(id) ON DELETE SET NULL;

ALTER TABLE dispatch_global_order_group_members
  ADD COLUMN IF NOT EXISTS hides_member boolean NOT NULL DEFAULT true;

-- Migration 190 knew only SO/TO groups. Pick up every current PO group and
-- true grouped-CO order as well. A normal CO for a grouped source is excluded:
-- its children are source detail, not separate CO members.
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
   WHERE upper(COALESCE(candidate.order_json ->> 'type', '')) IN ('SO', 'PO', 'TO', 'CO')
     AND jsonb_typeof(candidate.order_json -> 'childOrders') = 'array'
     AND jsonb_array_length(candidate.order_json -> 'childOrders') > 0
     AND (
       upper(candidate.order_json ->> 'type') <> 'CO'
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(candidate.order_json -> 'childOrders') child(ref)
          WHERE upper(child.ref) LIKE 'CO-%'
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(candidate.order_json -> 'childOrderDetails', '[]'::jsonb)) child(detail)
          WHERE upper(COALESCE(child.detail ->> 'type', '')) = 'CO'
             OR upper(COALESCE(child.detail ->> 'id', '')) LIKE 'CO-%'
       )
     )
     AND NULLIF(btrim(candidate.order_json ->> 'id'), '') IS NOT NULL
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
           - 'items'
           - 'childOrderDetails'
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
         ) || jsonb_build_object(
           'globalGroupDefinition', true,
           'globalGroupSourcePlanId', source_plan_id::text,
           'globalGroupSourcePlanDate', source_plan_date::text,
           'groupPlanId', '',
           'groupPlanDate', '',
           'planOwned', false,
           'dispatchPlanned', false,
           'catalogHydrated', false
         ),
         lower(concat_ws(' ', group_ref, order_json::text)),
         true,
         true,
         source_revision,
         updated_at
    FROM candidates
  ON CONFLICT DO NOTHING
  RETURNING group_ref, order_type, full_order
)
INSERT INTO dispatch_global_order_group_members (
  group_ref, member_order_ref, position, hides_member
)
SELECT inserted.group_ref,
       member.value,
       member.ordinality::integer - 1,
       true
  FROM inserted
  CROSS JOIN LATERAL jsonb_array_elements_text(inserted.full_order -> 'childOrders')
    WITH ORDINALITY AS member(value, ordinality)
ON CONFLICT (group_ref, member_order_ref) DO NOTHING;

CREATE TABLE IF NOT EXISTS dispatch_global_order_splits (
  split_ref text PRIMARY KEY,
  order_type text NOT NULL CHECK (order_type IN ('SO', 'PO', 'TO', 'CO', 'CUSTOM')),
  definition_kind text NOT NULL DEFAULT 'split'
    CHECK (definition_kind IN ('split', 'consolidation', 'derived')),
  parent_order_ref text NOT NULL DEFAULT '',
  source_plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  source_plan_date date NOT NULL,
  full_order jsonb NOT NULL,
  card jsonb NOT NULL,
  search_text text NOT NULL DEFAULT '',
  eligible boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  source_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_global_order_split_ref_not_blank
    CHECK (NULLIF(btrim(split_ref), '') IS NOT NULL),
  CONSTRAINT dispatch_global_order_split_parent_required
    CHECK (definition_kind <> 'split' OR NULLIF(btrim(parent_order_ref), '') IS NOT NULL),
  CONSTRAINT dispatch_global_order_split_documents
    CHECK (jsonb_typeof(full_order) = 'object' AND jsonb_typeof(card) = 'object'),
  CONSTRAINT dispatch_global_order_split_revision_nonnegative
    CHECK (source_revision >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_global_order_splits_ref_ci
  ON dispatch_global_order_splits (lower(split_ref));
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_splits_pool
  ON dispatch_global_order_splits (active, eligible, order_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_splits_parent
  ON dispatch_global_order_splits (definition_kind, lower(parent_order_ref), active);
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_splits_source_plan
  ON dispatch_global_order_splits (source_plan_id, active);
CREATE INDEX IF NOT EXISTS idx_dispatch_global_order_splits_search
  ON dispatch_global_order_splits USING gin (search_text gin_trgm_ops);

-- Backfill active split and local consolidation definitions from the latest
-- current plan snapshot.
-- Snapshot history is deliberately excluded: history is evidence, not live
-- global order state.
WITH candidates AS (
  SELECT DISTINCT ON (lower(candidate.order_json ->> 'id'))
         candidate.order_json ->> 'id' AS split_ref,
         upper(candidate.order_json ->> 'type') AS order_type,
         CASE
           WHEN NULLIF(btrim(candidate.order_json ->> 'originalOrderId'), '') IS NOT NULL THEN 'split'
           WHEN upper(candidate.order_json ->> 'id') LIKE 'TO-DRAFT-%' THEN 'consolidation'
           ELSE COALESCE(NULLIF(candidate.order_json ->> 'globalOrderDefinitionKind', ''), 'derived')
         END AS definition_kind,
         COALESCE(
           NULLIF(btrim(candidate.order_json ->> 'originalOrderId'), ''),
           NULLIF(btrim(candidate.order_json ->> 'sourceOrderId'), ''),
           ''
         ) AS parent_order_ref,
         plan.id AS source_plan_id,
         plan.plan_date AS source_plan_date,
         plan.revision AS source_revision,
         candidate.order_json,
         plan.updated_at
    FROM dispatch_plans plan
    JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb))
      AS candidate(order_json)
   WHERE upper(COALESCE(candidate.order_json ->> 'type', '')) IN ('SO', 'PO', 'TO', 'CO', 'CUSTOM')
     AND (
       NULLIF(btrim(candidate.order_json ->> 'originalOrderId'), '') IS NOT NULL
       OR upper(candidate.order_json ->> 'id') LIKE 'TO-DRAFT-%'
       OR NULLIF(btrim(candidate.order_json ->> 'globalOrderDefinitionKind'), '') IS NOT NULL
     )
     AND NULLIF(btrim(candidate.order_json ->> 'id'), '') IS NOT NULL
   ORDER BY lower(candidate.order_json ->> 'id'), plan.updated_at DESC, plan.id DESC
)
INSERT INTO dispatch_global_order_splits (
  split_ref, order_type, definition_kind, parent_order_ref, source_plan_id, source_plan_date,
  full_order, card, search_text, eligible, active, source_revision, updated_at
)
SELECT split_ref,
       order_type,
       definition_kind,
       parent_order_ref,
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
       ) || jsonb_build_object(
         'globalOrderDefinition', true,
         'globalOrderDefinitionKind', definition_kind,
         'globalOrderSourcePlanId', source_plan_id::text,
         'globalOrderSourcePlanDate', source_plan_date::text,
         'planOwned', false,
         'dispatchPlanned', false,
         'catalogHydrated', true
       ),
       (
         order_json
         - 'items'
         - 'childOrderDetails'
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
       ) || jsonb_build_object(
         'globalOrderDefinition', true,
         'globalOrderDefinitionKind', definition_kind,
         'globalOrderSourcePlanId', source_plan_id::text,
         'globalOrderSourcePlanDate', source_plan_date::text,
         'planOwned', false,
         'dispatchPlanned', false,
         'catalogHydrated', false
       ),
       lower(concat_ws(' ', split_ref, parent_order_ref, order_json::text)),
       true,
       true,
       source_revision,
       updated_at
  FROM candidates
ON CONFLICT DO NOTHING;

COMMENT ON TABLE dispatch_global_order_splits IS
  'Canonical global Dispatch split and local derived-order definitions; truck/load/date assignment is projected separately.';
