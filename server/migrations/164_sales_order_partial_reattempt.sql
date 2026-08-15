-- A completed Sales Order re-attempt is transport work linked to immutable original
-- load/completion evidence. It is intentionally not an inventory return/reservation
-- and not an independently billable Custom Order.

ALTER TABLE operator_reload_cycles
  ADD COLUMN IF NOT EXISTS workflow_kind text NOT NULL DEFAULT 'standard_reload',
  ADD COLUMN IF NOT EXISTS source_load_record_id bigint REFERENCES operator_load_records(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reattempt_order_ref text,
  ADD COLUMN IF NOT EXISTS reattempt_order_id bigint;

ALTER TABLE operator_reload_cycles
  DROP CONSTRAINT IF EXISTS operator_reload_cycles_workflow_kind_valid;
ALTER TABLE operator_reload_cycles
  ADD CONSTRAINT operator_reload_cycles_workflow_kind_valid
  CHECK (workflow_kind IN ('standard_reload', 'sales_order_reattempt'));

ALTER TABLE operator_reload_cycles
  DROP CONSTRAINT IF EXISTS operator_reload_cycles_reattempt_evidence_valid;
ALTER TABLE operator_reload_cycles
  ADD CONSTRAINT operator_reload_cycles_reattempt_evidence_valid
  CHECK (
    workflow_kind <> 'sales_order_reattempt'
    OR (
      source_load_record_id IS NOT NULL
      AND NULLIF(btrim(COALESCE(reattempt_order_ref, '')), '') IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_reload_cycles_reattempt_ref
  ON operator_reload_cycles (lower(btrim(reattempt_order_ref)))
  WHERE reattempt_order_ref IS NOT NULL;

ALTER TABLE operator_reload_cycle_lines
  ALTER COLUMN sales_order_line_id DROP NOT NULL;

ALTER TABLE operator_reload_cycle_lines
  DROP CONSTRAINT IF EXISTS operator_reload_cycle_lines_target_sales_qty_check;
ALTER TABLE operator_reload_cycle_lines
  ADD CONSTRAINT operator_reload_cycle_lines_target_sales_qty_check
  CHECK (target_sales_qty >= 0);

ALTER TABLE operator_reload_cycle_lines
  ADD COLUMN IF NOT EXISTS line_key text,
  ADD COLUMN IF NOT EXISTS historical_line_index integer,
  ADD COLUMN IF NOT EXISTS historical_line_id bigint,
  ADD COLUMN IF NOT EXISTS historical_item_id bigint,
  ADD COLUMN IF NOT EXISTS historical_item_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS historical_sku text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS historical_description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS historical_sales_uom text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS historical_loaded_sales_qty numeric NOT NULL DEFAULT 0 CHECK (historical_loaded_sales_qty >= 0),
  ADD COLUMN IF NOT EXISTS historical_pallet_qty numeric NOT NULL DEFAULT 0 CHECK (historical_pallet_qty >= 0),
  ADD COLUMN IF NOT EXISTS historical_layer_qty numeric NOT NULL DEFAULT 0 CHECK (historical_layer_qty >= 0),
  ADD COLUMN IF NOT EXISTS historical_section_qty numeric NOT NULL DEFAULT 0 CHECK (historical_section_qty >= 0),
  ADD COLUMN IF NOT EXISTS historical_piece_qty numeric NOT NULL DEFAULT 0 CHECK (historical_piece_qty >= 0),
  ADD COLUMN IF NOT EXISTS current_sales_order_line_id bigint REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS current_line_id bigint,
  ADD COLUMN IF NOT EXISTS current_item_id bigint,
  ADD COLUMN IF NOT EXISTS current_item_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS current_sku text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS current_description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS current_sales_qty numeric NOT NULL DEFAULT 0 CHECK (current_sales_qty >= 0),
  ADD COLUMN IF NOT EXISTS current_sales_uom text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sku_mismatch boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS item_mismatch boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selected_for_reattempt boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS selection_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS already_delivered_sales_qty numeric NOT NULL DEFAULT 0 CHECK (already_delivered_sales_qty >= 0),
  ADD COLUMN IF NOT EXISTS already_delivered_pallet_qty numeric NOT NULL DEFAULT 0 CHECK (already_delivered_pallet_qty >= 0),
  ADD COLUMN IF NOT EXISTS already_delivered_layer_qty numeric NOT NULL DEFAULT 0 CHECK (already_delivered_layer_qty >= 0),
  ADD COLUMN IF NOT EXISTS already_delivered_section_qty numeric NOT NULL DEFAULT 0 CHECK (already_delivered_section_qty >= 0),
  ADD COLUMN IF NOT EXISTS already_delivered_piece_qty numeric NOT NULL DEFAULT 0 CHECK (already_delivered_piece_qty >= 0),
  ADD COLUMN IF NOT EXISTS item_weight numeric NOT NULL DEFAULT 0 CHECK (item_weight >= 0);

WITH legacy_line_index AS (
  SELECT id, (row_number() OVER (PARTITION BY cycle_id ORDER BY id) - 1)::integer AS value
    FROM operator_reload_cycle_lines
)
UPDATE operator_reload_cycle_lines line
   SET line_key = COALESCE(line.line_key, 'legacy:' || line.cycle_id::text || ':' || line.id::text),
       historical_line_index = COALESCE(line.historical_line_index, legacy_line_index.value),
       historical_line_id = COALESCE(line.historical_line_id, line.netsuite_line_id),
       historical_item_id = COALESCE(line.historical_item_id, line.item_id),
       historical_item_name = COALESCE(NULLIF(line.historical_item_name, ''), line.item_name, ''),
       historical_sku = COALESCE(NULLIF(line.historical_sku, ''), line.sku, line.item_name, ''),
       historical_description = COALESCE(NULLIF(line.historical_description, ''), line.item_description, ''),
       historical_sales_uom = COALESCE(NULLIF(line.historical_sales_uom, ''), line.sales_uom, ''),
       historical_loaded_sales_qty = GREATEST(line.historical_loaded_sales_qty, line.target_sales_qty),
       historical_pallet_qty = GREATEST(line.historical_pallet_qty, line.target_pallet_qty),
       historical_layer_qty = GREATEST(line.historical_layer_qty, line.target_layer_qty),
       historical_section_qty = GREATEST(line.historical_section_qty, line.target_section_qty),
       historical_piece_qty = GREATEST(line.historical_piece_qty, line.target_piece_qty),
       current_sales_order_line_id = COALESCE(line.current_sales_order_line_id, line.sales_order_line_id),
       current_line_id = COALESCE(line.current_line_id, line.netsuite_line_id),
       current_item_id = COALESCE(line.current_item_id, line.item_id),
       current_item_name = COALESCE(NULLIF(line.current_item_name, ''), line.item_name, ''),
       current_sku = COALESCE(NULLIF(line.current_sku, ''), line.sku, ''),
       current_description = COALESCE(NULLIF(line.current_description, ''), line.item_description, ''),
       current_sales_qty = GREATEST(line.current_sales_qty, line.target_sales_qty),
       current_sales_uom = COALESCE(NULLIF(line.current_sales_uom, ''), line.sales_uom, ''),
       selected_for_reattempt = true,
       selection_reason = COALESCE(NULLIF(btrim(line.selection_reason), ''), cycle.reason),
       already_delivered_sales_qty = 0,
       already_delivered_pallet_qty = 0,
       already_delivered_layer_qty = 0,
       already_delivered_section_qty = 0,
       already_delivered_piece_qty = 0
  FROM operator_reload_cycles cycle, legacy_line_index
 WHERE cycle.id = line.cycle_id
   AND legacy_line_index.id = line.id;

ALTER TABLE operator_reload_cycle_lines
  DROP CONSTRAINT IF EXISTS operator_reload_cycle_lines_selection_valid;
ALTER TABLE operator_reload_cycle_lines
  ADD CONSTRAINT operator_reload_cycle_lines_selection_valid
  CHECK (
    (selected_for_reattempt AND target_sales_qty > 0 AND char_length(btrim(selection_reason)) BETWEEN 1 AND 500)
    OR (NOT selected_for_reattempt AND target_sales_qty = 0 AND btrim(selection_reason) = '')
  );

ALTER TABLE operator_reload_cycle_lines
  DROP CONSTRAINT IF EXISTS operator_reload_cycle_lines_sales_conservation;
ALTER TABLE operator_reload_cycle_lines
  ADD CONSTRAINT operator_reload_cycle_lines_sales_conservation
  CHECK (
    historical_loaded_sales_qty = 0
    OR abs((target_sales_qty + already_delivered_sales_qty) - historical_loaded_sales_qty) <= 0.1
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_reload_cycle_lines_historical_index
  ON operator_reload_cycle_lines (cycle_id, historical_line_index)
  WHERE historical_line_index IS NOT NULL;

ALTER TABLE dispatch_custom_orders
  ALTER COLUMN weight_lbs TYPE numeric(16, 6),
  ADD COLUMN IF NOT EXISTS order_kind text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS system_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parent_sales_order_id bigint REFERENCES sales_orders(netsuite_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS parent_order_ref text,
  ADD COLUMN IF NOT EXISTS reload_cycle_id bigint REFERENCES operator_reload_cycles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pallet_qty numeric NOT NULL DEFAULT 0 CHECK (pallet_qty >= 0),
  ADD COLUMN IF NOT EXISTS layer_qty numeric NOT NULL DEFAULT 0 CHECK (layer_qty >= 0),
  ADD COLUMN IF NOT EXISTS section_qty numeric NOT NULL DEFAULT 0 CHECK (section_qty >= 0),
  ADD COLUMN IF NOT EXISTS piece_qty numeric NOT NULL DEFAULT 0 CHECK (piece_qty >= 0),
  ADD COLUMN IF NOT EXISTS sales_qty numeric NOT NULL DEFAULT 0 CHECK (sales_qty >= 0),
  ADD COLUMN IF NOT EXISTS billing_disposition text NOT NULL DEFAULT 'standard';

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_order_kind_valid;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_order_kind_valid
  CHECK (order_kind IN ('custom', 'sales_order_reattempt'));

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_billing_disposition_valid;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_billing_disposition_valid
  CHECK (billing_disposition IN ('standard', 'linked_parent_no_charge'));

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_reattempt_link_valid;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_reattempt_link_valid
  CHECK (
    order_kind <> 'sales_order_reattempt'
    OR (
      system_managed
      AND parent_sales_order_id IS NOT NULL
      AND NULLIF(btrim(COALESCE(parent_order_ref, '')), '') IS NOT NULL
      AND reload_cycle_id IS NOT NULL
      AND billing_disposition = 'linked_parent_no_charge'
      AND jsonb_typeof(line_snapshot) = 'array'
      AND jsonb_array_length(line_snapshot) > 0
      AND sales_qty > 0
    )
  );

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_weight_valid;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_weight_valid
  CHECK (
    weight_lbs >= 0
    AND weight_lbs <= 1000000
    AND (order_kind = 'sales_order_reattempt' OR weight_lbs > 0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_custom_orders_reload_cycle
  ON dispatch_custom_orders (reload_cycle_id)
  WHERE reload_cycle_id IS NOT NULL;

ALTER TABLE operator_reload_cycles
  DROP CONSTRAINT IF EXISTS operator_reload_cycles_reattempt_order_fk;
ALTER TABLE operator_reload_cycles
  ADD CONSTRAINT operator_reload_cycles_reattempt_order_fk
  FOREIGN KEY (reattempt_order_id) REFERENCES dispatch_custom_orders(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_reload_cycles_reattempt_order
  ON operator_reload_cycles (reattempt_order_id)
  WHERE reattempt_order_id IS NOT NULL;

COMMENT ON COLUMN operator_reload_cycles.workflow_kind IS
  'standard_reload is the legacy pre-drop-off workflow; sales_order_reattempt is a completed-drop-off partial retry.';
COMMENT ON COLUMN operator_reload_cycles.source_load_record_id IS
  'Immutable original Operator load evidence used to authorize a completed Sales Order re-attempt.';
COMMENT ON COLUMN dispatch_custom_orders.order_kind IS
  'Transport classification. sales_order_reattempt rows are system-managed linked SO children, not ordinary Custom Orders.';
COMMENT ON COLUMN dispatch_custom_orders.billing_disposition IS
  'linked_parent_no_charge excludes a re-attempt child from independent billing while retaining its transport evidence.';

-- Preserve universal Dispatch completion status for the child while keeping its
-- explicit no-charge disposition available to every billing-candidate source.
CREATE OR REPLACE FUNCTION dispatch_project_custom_order_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL THEN
    PERFORM dispatch_record_order_completion(
      CASE WHEN NEW.order_kind = 'sales_order_reattempt' THEN 'SO' ELSE 'CUSTOM' END,
      NEW.ref_number,
      NEW.completed_at,
      'custom_order',
      'custom_order:' || NEW.id::text,
      NULL,
      NULL,
      NULL,
      CASE WHEN NULLIF(btrim(COALESCE(NEW.updated_by, '')), '') IS NULL THEN 'system' ELSE 'operator' END,
      COALESCE(NEW.updated_by, ''),
      '',
      jsonb_build_object(
        'customOrderId', NEW.id,
        'orderKind', NEW.order_kind,
        'parentOrderRef', COALESCE(NEW.parent_order_ref, ''),
        'billingDisposition', NEW.billing_disposition
      )
    );
  END IF;
  RETURN NEW;
END
$$;
