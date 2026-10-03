ALTER TABLE scm_smart_settings ADD COLUMN IF NOT EXISTS regular_stock_lead_hours numeric NOT NULL DEFAULT 5
  CHECK (regular_stock_lead_hours >= 0 AND regular_stock_lead_hours <= 87600);
ALTER TABLE sales_stock_requests ADD COLUMN IF NOT EXISTS workflow_version integer NOT NULL DEFAULT 1;
ALTER TABLE sales_stock_requests ADD COLUMN IF NOT EXISTS regular_details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sales_stock_requests ADD COLUMN IF NOT EXISTS manual_decision_event_id bigint NOT NULL DEFAULT 0;
ALTER TABLE sales_stock_request_lines ADD COLUMN IF NOT EXISTS regular_decision text
  CHECK (regular_decision IN ('stock','po','reject'));
ALTER TABLE sales_stock_request_lines ADD COLUMN IF NOT EXISTS approval_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sales_stock_request_lines DROP CONSTRAINT sales_stock_request_lines_status_check;
ALTER TABLE sales_stock_request_lines ADD CONSTRAINT sales_stock_request_lines_status_check CHECK (
  status IN ('submitted','changes_requested','approved','converted','fulfilled','rejected','received','cancelled','closed'));

CREATE TABLE regular_stock_decision_reads (
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  event_id bigint NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,operator_id)
);
CREATE TABLE regular_stock_handoffs (
  request_id bigint PRIMARY KEY REFERENCES sales_stock_requests(id) ON DELETE RESTRICT,
  sales_order_id bigint NOT NULL,
  sales_order_ref text NOT NULL,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','executing','attention','complete')),
  attempt_id text,
  lease_until timestamptz,
  remote_started_at timestamptz,
  location_applied boolean NOT NULL DEFAULT false,
  replenishment_ready boolean NOT NULL DEFAULT false,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE regular_stock_so_line_owners (
  sales_order_id bigint NOT NULL,
  remote_line_id bigint NOT NULL,
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE RESTRICT,
  PRIMARY KEY(sales_order_id,remote_line_id)
);
CREATE TABLE regular_stock_replenishments (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  source_location_id bigint NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  quantity numeric NOT NULL DEFAULT 0 CHECK(quantity>=0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_proposal_id bigint REFERENCES scm_smart_proposals(id) ON DELETE RESTRICT,
  released_by text REFERENCES operators(id) ON DELETE RESTRICT,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regular_stock_replenishments_active_item_yard
  ON regular_stock_replenishments(item_id,source_location_id) WHERE released_at IS NULL;
CREATE TABLE regular_stock_replenishment_requests (
  request_line_id bigint PRIMARY KEY REFERENCES sales_stock_request_lines(id) ON DELETE RESTRICT,
  replenishment_id bigint NOT NULL REFERENCES regular_stock_replenishments(id) ON DELETE RESTRICT
);
ALTER TABLE scm_smart_proposals ADD COLUMN IF NOT EXISTS regular_replenishment_id bigint REFERENCES regular_stock_replenishments(id);
CREATE TABLE regular_stock_replenishment_runs (
  replenishment_id bigint NOT NULL REFERENCES regular_stock_replenishments(id),
  run_id bigint NOT NULL REFERENCES scm_smart_planning_runs(id),
  PRIMARY KEY(replenishment_id,run_id)
);
CREATE INDEX regular_stock_manual_review ON sales_stock_requests(workflow_version,status,id) WHERE workflow_version=2;
