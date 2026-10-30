-- Source-linked cargo trips are independent of rental/financial contracts.
CREATE TABLE mbt_aggregate_routing_items (
  item_id bigint PRIMARY KEY CHECK (item_id>0),
  bin_only boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mbt_aggregate_routing_items(item_id,bin_only,updated_by)
  SELECT id,true,'migration:309' FROM unnest(ARRAY[9909,9910,9912,9913,9914,9915,9916,9917,9919,9921,9922]::bigint[]) id;

CREATE FUNCTION mbt_bin_only_source(source_order jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(source_order->>'type','')<>'BIN' AND (
    EXISTS (SELECT 1 FROM jsonb_path_query(source_order,'$.**.items[*].itemId') item
      JOIN mbt_aggregate_routing_items routing ON routing.item_id::text=item #>> '{}'
      WHERE routing.bin_only)
    OR EXISTS (SELECT 1 FROM dispatch_custom_orders c WHERE c.mbt_source='frontdesk_aggregate'
      AND lower(c.ref_number)=lower(COALESCE(source_order->>'id',source_order->>'refNumber','')))
  );
$$;

CREATE TABLE mbt_transport_sources (
  source_key text PRIMARY KEY CHECK (source_key=lower(source_key) AND length(source_key) BETWEEN 1 AND 200),
  source_ref text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('sor_delivery','sor_return','aggregate','frontdesk_aggregate')),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  source_fingerprint text NOT NULL,
  claimed boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  cargo_completed_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mbt_transport_trips (
  trip_id uuid PRIMARY KEY,
  source_key text NOT NULL REFERENCES mbt_transport_sources(source_key) ON DELETE RESTRICT,
  trip_number integer NOT NULL CHECK (trip_number>0),
  asset_id uuid NOT NULL REFERENCES mbt_bin_assets(asset_id) ON DELETE RESTRICT,
  allocations jsonb NOT NULL CHECK (jsonb_typeof(allocations)='array' AND jsonb_array_length(allocations)>0),
  weight_lbs numeric(16,3) NOT NULL CHECK (weight_lbs>0 AND weight_lbs<=1000000),
  route jsonb NOT NULL CHECK (jsonb_typeof(route)='object'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','planned','in_progress','completed','cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  generation integer NOT NULL DEFAULT 0 CHECK (generation>=0),
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE RESTRICT,
  load_id text,
  truck_id bigint REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  driver_id bigint REFERENCES dispatch_drivers(id) ON DELETE RESTRICT,
  reserved_from timestamptz,
  reserved_until timestamptz,
  assignment_snapshot jsonb,
  driver_released_at timestamptz,
  actual_started_at timestamptz,
  cargo_delivered_at timestamptz,
  actual_completed_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_key,trip_number),
  CHECK ((plan_id IS NULL)=(load_id IS NULL)),
  CHECK (reserved_until IS NULL OR reserved_until>=reserved_from)
);
CREATE INDEX mbt_transport_planned_assets ON mbt_transport_trips(asset_id,reserved_from) WHERE plan_id IS NOT NULL AND status NOT IN ('completed','cancelled');
CREATE INDEX mbt_transport_plan ON mbt_transport_trips(plan_id) WHERE plan_id IS NOT NULL;
CREATE TABLE mbt_transport_delivery_links (
  link_id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES mbt_transport_trips(trip_id),
  delivery_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id),
  original_snapshot jsonb NOT NULL,
  original_steps jsonb NOT NULL,
  original_requirements jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX mbt_transport_delivery_active ON mbt_transport_delivery_links(delivery_visit_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX mbt_transport_trip_delivery_active ON mbt_transport_delivery_links(trip_id) WHERE released_at IS NULL;
CREATE TABLE mbt_transport_steps (
  step_id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES mbt_transport_trips(trip_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL CHECK (sequence_number>0),
  action_code text NOT NULL,
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  started_at timestamptz,
  completed_at timestamptz,
  evidence jsonb,
  UNIQUE(trip_id,sequence_number),
  UNIQUE(trip_id,action_code)
);
CREATE TABLE mbt_transport_assignment_history (
  assignment_id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES mbt_transport_trips(trip_id) ON DELETE RESTRICT,
  generation integer NOT NULL,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  withdrawn_at timestamptz,
  UNIQUE(trip_id,generation)
);
CREATE TABLE mbt_transport_driver_events (
  event_id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES mbt_transport_trips(trip_id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES mbt_transport_steps(step_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('job_started','job_completed')),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
