CREATE TEMP TABLE _mbbs_sales_orders AS SELECT * FROM sales_orders;
CREATE TEMP TABLE _mbbs_sales_order_lines AS SELECT * FROM sales_order_lines;
CREATE TEMP TABLE _mbbs_transfer_orders AS SELECT * FROM transfer_orders;
CREATE TEMP TABLE _mbbs_transfer_order_lines AS SELECT * FROM transfer_order_lines;
CREATE TEMP TABLE _mbbs_purchase_orders AS SELECT * FROM purchase_orders;
CREATE TEMP TABLE _mbbs_purchase_order_lines AS SELECT * FROM purchase_order_lines;
CREATE TEMP TABLE _mbbs_co_orders AS SELECT * FROM co_orders;
CREATE TEMP TABLE _mbbs_co_order_lines AS SELECT * FROM co_order_lines;

DROP VIEW IF EXISTS co_order_lines;
DROP VIEW IF EXISTS co_orders;
DROP VIEW IF EXISTS purchase_order_lines;
DROP VIEW IF EXISTS purchase_orders;
DROP VIEW IF EXISTS transfer_order_lines;
DROP VIEW IF EXISTS transfer_orders;
DROP VIEW IF EXISTS sales_order_lines;
DROP VIEW IF EXISTS sales_orders;

CREATE TABLE sales_orders AS SELECT * FROM _mbbs_sales_orders;
CREATE TABLE sales_order_lines AS SELECT * FROM _mbbs_sales_order_lines;
CREATE TABLE transfer_orders AS SELECT * FROM _mbbs_transfer_orders;
CREATE TABLE transfer_order_lines AS SELECT * FROM _mbbs_transfer_order_lines;
CREATE TABLE purchase_orders AS SELECT * FROM _mbbs_purchase_orders;
CREATE TABLE purchase_order_lines AS SELECT * FROM _mbbs_purchase_order_lines;
CREATE TABLE co_orders AS SELECT * FROM _mbbs_co_orders;
CREATE TABLE co_order_lines AS SELECT * FROM _mbbs_co_order_lines;

ALTER TABLE sales_orders ADD PRIMARY KEY (netsuite_id);
ALTER TABLE sales_order_lines ADD PRIMARY KEY (id);
ALTER TABLE transfer_orders ADD PRIMARY KEY (netsuite_id);
ALTER TABLE transfer_order_lines ADD PRIMARY KEY (line_stage, id);
ALTER TABLE purchase_orders ADD PRIMARY KEY (netsuite_id);
ALTER TABLE purchase_order_lines ADD PRIMARY KEY (id);
ALTER TABLE co_orders ADD PRIMARY KEY (id);
ALTER TABLE co_order_lines ADD PRIMARY KEY (id);

CREATE UNIQUE INDEX idx_sales_order_lines_order_line
  ON sales_order_lines (sales_order_id, line_id);

CREATE INDEX idx_sales_orders_type_status
  ON sales_orders (sales_order_type, status_text, netsuite_active, trandate DESC);

CREATE INDEX idx_sales_orders_location_status
  ON sales_orders (outbound_location_id, sales_order_type, netsuite_active, trandate DESC);

CREATE INDEX idx_transfer_order_lines_order_stage
  ON transfer_order_lines (transfer_order_id, line_stage, line_id);

CREATE INDEX idx_purchase_order_lines_order_line
  ON purchase_order_lines (purchase_order_id, line_id);

CREATE INDEX idx_purchase_orders_vendor_status
  ON purchase_orders (vendor, status_text, netsuite_active, trandate DESC);

CREATE INDEX idx_co_orders_status_destination
  ON co_orders (status, to_location_id, created_at DESC);

CREATE INDEX idx_co_order_lines_co
  ON co_order_lines (co_id, line_id);

CREATE OR REPLACE FUNCTION mbbs_rebuild_sales_order(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM sales_orders WHERE netsuite_id = p_order_id;

  INSERT INTO sales_orders (
    netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
    foreign_total, order_location_id, order_location, outbound_location_id,
    outbound_location, delivery_method_id, sales_order_type, memo,
    expected_delivery_date, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, operator_status,
    local_yard_order_status, netsuite_active, synced_at, dispatch_parse_source,
    dispatch_note_hash, dispatch_parsed_at, fulfillment_status, dispatch_planned,
    dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
    dispatch_parking_spot, dispatch_planned_at, netsuite_missing_at
  )
  SELECT
    netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
    foreign_total, order_location_id, order_location, outbound_location_id,
    outbound_location, delivery_method_id, delivery_method, memo,
    expected_delivery_date, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, operator_status,
    local_yard_order_status, netsuite_active, synced_at, dispatch_parse_source,
    dispatch_note_hash, dispatch_parsed_at, fulfillment_status, dispatch_planned,
    dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
    dispatch_parking_spot, dispatch_planned_at, netsuite_missing_at
  FROM delivery_orders
  WHERE netsuite_id = p_order_id
    AND order_type = 'sales_order';
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_sales_order_lines(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM sales_order_lines WHERE sales_order_id = p_order_id;

  INSERT INTO sales_order_lines (
    id, sales_order_id, line_id, item_id, item_name, sku, item_description,
    item_type, item_type_text, quantity, unit, pallet_qty, layer_qty,
    section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
    packed_pallet_qty, packed_layer_qty, packed_section_qty,
    packed_piece_qty, confirmed, confirmed_at, loaded_qty, loaded_uom,
    netsuite_active, sync_exception, synced_at, location_id, location,
    item_weight
  )
  SELECT
    l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
    l.item_description, l.item_type, l.item_type_text, l.quantity, l.unit,
    l.pallet_qty, l.layer_qty, l.section_qty, l.piece_qty, l.to_plt,
    l.to_lyr, l.to_sec, l.to_pcs, l.packed_pallet_qty, l.packed_layer_qty,
    l.packed_section_qty, l.packed_piece_qty, l.confirmed, l.confirmed_at,
    l.loaded_qty, l.loaded_uom, l.netsuite_active, l.sync_exception,
    l.synced_at, l.location_id, l.location, l.item_weight
  FROM delivery_order_lines l
  JOIN delivery_orders o ON o.netsuite_id = l.order_id
  WHERE l.order_id = p_order_id
    AND o.order_type = 'sales_order';
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_transfer_order(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM transfer_orders WHERE netsuite_id = p_order_id;

  INSERT INTO transfer_orders (
    netsuite_id, tranid, trandate, status, status_text, from_location_id,
    from_location, to_location_id, to_location, outbound_operator_status,
    receiving_status, netsuite_active, synced_at, memo, expected_delivery_date,
    dispatch_address, dispatch_window_start, dispatch_window_end,
    dispatch_instructions, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, local_yard_order_status, fulfillment_status,
    dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
    dispatch_load_name, dispatch_parking_spot, dispatch_planned_at,
    netsuite_missing_at
  )
  SELECT
    COALESCE(d.netsuite_id, r.netsuite_id) AS netsuite_id,
    COALESCE(d.tranid, r.tranid) AS tranid,
    COALESCE(d.trandate, r.trandate) AS trandate,
    COALESCE(d.status, r.status) AS status,
    COALESCE(d.status_text, r.status_text) AS status_text,
    COALESCE(d.source_location_id, r.source_location_id, d.outbound_location_id) AS from_location_id,
    COALESCE(d.source_location, r.source_location, d.outbound_location) AS from_location,
    COALESCE(d.destination_location_id, r.destination_location_id) AS to_location_id,
    COALESCE(d.destination_location, r.destination_location) AS to_location,
    d.operator_status AS outbound_operator_status,
    r.receipt_status AS receiving_status,
    COALESCE(d.netsuite_active, r.netsuite_active, true) AS netsuite_active,
    GREATEST(COALESCE(d.synced_at, '-infinity'::timestamptz), COALESCE(r.synced_at, '-infinity'::timestamptz)) AS synced_at,
    COALESCE(d.memo, r.memo) AS memo,
    COALESCE(d.expected_delivery_date, r.expected_delivery_date) AS expected_delivery_date,
    COALESCE(d.dispatch_address, r.dispatch_address) AS dispatch_address,
    COALESCE(d.dispatch_window_start, r.dispatch_window_start) AS dispatch_window_start,
    COALESCE(d.dispatch_window_end, r.dispatch_window_end) AS dispatch_window_end,
    COALESCE(d.dispatch_instructions, r.dispatch_instructions) AS dispatch_instructions,
    COALESCE(d.dispatch_parse_source, r.dispatch_parse_source) AS dispatch_parse_source,
    COALESCE(d.dispatch_note_hash, r.dispatch_note_hash) AS dispatch_note_hash,
    GREATEST(COALESCE(d.dispatch_parsed_at, '-infinity'::timestamptz), COALESCE(r.dispatch_parsed_at, '-infinity'::timestamptz)) AS dispatch_parsed_at,
    d.local_yard_order_status,
    d.fulfillment_status,
    d.dispatch_planned,
    d.dispatch_plan_date,
    d.dispatch_truck_plate,
    d.dispatch_load_name,
    d.dispatch_parking_spot,
    d.dispatch_planned_at,
    COALESCE(d.netsuite_missing_at, r.netsuite_missing_at) AS netsuite_missing_at
  FROM (SELECT * FROM delivery_orders WHERE order_type = 'transfer_order' AND netsuite_id = p_order_id) d
  FULL JOIN (SELECT * FROM receiving_orders WHERE order_type = 'transfer_order' AND netsuite_id = p_order_id) r
    ON r.netsuite_id = d.netsuite_id
  WHERE COALESCE(d.netsuite_id, r.netsuite_id) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_transfer_order_lines(p_order_id bigint, p_stage text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM transfer_order_lines
  WHERE transfer_order_id = p_order_id
    AND line_stage = p_stage;

  IF p_stage = 'outbound' THEN
    INSERT INTO transfer_order_lines (
      line_stage, id, transfer_order_id, line_id, item_id, item_name, sku,
      item_description, quantity, unit, pallet_qty, layer_qty, section_qty,
      piece_qty, loaded_qty, loaded_uom, netsuite_active, sync_exception,
      synced_at, item_type, item_type_text, location_id, location, to_plt,
      to_lyr, to_sec, to_pcs, packed_pallet_qty, packed_layer_qty,
      packed_section_qty, packed_piece_qty, received_pallet_qty,
      received_layer_qty, received_section_qty, received_piece_qty,
      netsuite_received_qty, item_weight
    )
    SELECT
      'outbound', l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
      l.item_description, l.quantity, l.unit, l.pallet_qty, l.layer_qty,
      l.section_qty, l.piece_qty, l.loaded_qty, l.loaded_uom,
      l.netsuite_active, l.sync_exception, l.synced_at, l.item_type,
      l.item_type_text, l.location_id, l.location, l.to_plt, l.to_lyr,
      l.to_sec, l.to_pcs, l.packed_pallet_qty, l.packed_layer_qty,
      l.packed_section_qty, l.packed_piece_qty, 0, 0, 0, 0, 0, l.item_weight
    FROM delivery_order_lines l
    JOIN delivery_orders o ON o.netsuite_id = l.order_id
    WHERE l.order_id = p_order_id
      AND o.order_type = 'transfer_order';
  ELSIF p_stage = 'receiving' THEN
    INSERT INTO transfer_order_lines (
      line_stage, id, transfer_order_id, line_id, item_id, item_name, sku,
      item_description, quantity, unit, pallet_qty, layer_qty, section_qty,
      piece_qty, loaded_qty, loaded_uom, netsuite_active, sync_exception,
      synced_at, item_type, item_type_text, location_id, location, to_plt,
      to_lyr, to_sec, to_pcs, packed_pallet_qty, packed_layer_qty,
      packed_section_qty, packed_piece_qty, received_pallet_qty,
      received_layer_qty, received_section_qty, received_piece_qty,
      netsuite_received_qty, item_weight
    )
    SELECT
      'receiving', l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
      l.item_description, l.quantity, l.unit, l.pallet_qty, l.layer_qty,
      l.section_qty, l.piece_qty, l.netsuite_received_qty, l.unit,
      l.netsuite_active, l.sync_exception, l.synced_at, l.item_type,
      l.item_type_text, l.location_id, l.location, l.to_plt, l.to_lyr,
      l.to_sec, l.to_pcs, 0, 0, 0, 0, l.received_pallet_qty,
      l.received_layer_qty, l.received_section_qty, l.received_piece_qty,
      l.netsuite_received_qty, l.item_weight
    FROM receiving_order_lines l
    JOIN receiving_orders o ON o.netsuite_id = l.order_id
    WHERE l.order_id = p_order_id
      AND o.order_type = 'transfer_order';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_purchase_order(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM purchase_orders WHERE netsuite_id = p_order_id;

  INSERT INTO purchase_orders (
    netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
    foreign_total, destination_location_id, destination_location, memo,
    dispatch_vendor_yard, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, receipt_status,
    netsuite_active, synced_at, source_location_id, source_location,
    expected_delivery_date, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, netsuite_missing_at
  )
  SELECT
    netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
    foreign_total, destination_location_id, destination_location, memo,
    dispatch_vendor_yard, dispatch_address, dispatch_window_start,
    dispatch_window_end, dispatch_instructions, receipt_status,
    netsuite_active, synced_at, source_location_id, source_location,
    expected_delivery_date, dispatch_parse_source, dispatch_note_hash,
    dispatch_parsed_at, netsuite_missing_at
  FROM receiving_orders
  WHERE netsuite_id = p_order_id
    AND order_type = 'purchase_order';
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_purchase_order_lines(p_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM purchase_order_lines WHERE purchase_order_id = p_order_id;

  INSERT INTO purchase_order_lines (
    id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
    item_type, item_type_text, quantity, unit, location_id, location,
    pallet_qty, layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec,
    to_pcs, received_pallet_qty, received_layer_qty, received_section_qty,
    received_piece_qty, netsuite_received_qty, netsuite_active,
    sync_exception, synced_at, item_weight
  )
  SELECT
    l.id, l.order_id, l.line_id, l.item_id, l.item_name, l.sku,
    l.item_description, l.item_type, l.item_type_text, l.quantity, l.unit,
    l.location_id, l.location, l.pallet_qty, l.layer_qty, l.section_qty,
    l.piece_qty, l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
    l.received_pallet_qty, l.received_layer_qty, l.received_section_qty,
    l.received_piece_qty, l.netsuite_received_qty, l.netsuite_active,
    l.sync_exception, l.synced_at, l.item_weight
  FROM receiving_order_lines l
  JOIN receiving_orders o ON o.netsuite_id = l.order_id
  WHERE l.order_id = p_order_id
    AND o.order_type = 'purchase_order';
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_co_order(p_co_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM co_orders WHERE id = p_co_id;
  INSERT INTO co_orders SELECT * FROM local_co_orders WHERE id = p_co_id;
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_rebuild_co_order_lines(p_co_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM co_order_lines WHERE co_id = p_co_id;
  INSERT INTO co_order_lines SELECT * FROM local_co_order_lines WHERE co_id = p_co_id;
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_delivery_order_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.netsuite_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.netsuite_id END;
BEGIN
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_sales_order(v_old_id);
    PERFORM mbbs_rebuild_sales_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'outbound');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_sales_order(v_new_id);
    PERFORM mbbs_rebuild_sales_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'outbound');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_delivery_line_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.order_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.order_id END;
BEGIN
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_sales_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'outbound');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_sales_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'outbound');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_receiving_order_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.netsuite_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.netsuite_id END;
BEGIN
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_purchase_order(v_old_id);
    PERFORM mbbs_rebuild_purchase_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'receiving');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_purchase_order(v_new_id);
    PERFORM mbbs_rebuild_purchase_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'receiving');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_receiving_line_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_id bigint := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.order_id END;
  v_new_id bigint := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.order_id END;
BEGIN
  IF v_old_id IS NOT NULL THEN
    PERFORM mbbs_rebuild_purchase_order_lines(v_old_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_old_id, 'receiving');
  END IF;
  IF v_new_id IS NOT NULL AND v_new_id IS DISTINCT FROM v_old_id THEN
    PERFORM mbbs_rebuild_purchase_order_lines(v_new_id);
    PERFORM mbbs_rebuild_transfer_order_lines(v_new_id, 'receiving');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_co_order_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM mbbs_rebuild_co_order(OLD.id);
    PERFORM mbbs_rebuild_co_order_lines(OLD.id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.id IS DISTINCT FROM OLD.id) THEN
    PERFORM mbbs_rebuild_co_order(NEW.id);
    PERFORM mbbs_rebuild_co_order_lines(NEW.id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION mbbs_co_line_canonical_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM mbbs_rebuild_co_order_lines(OLD.co_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.co_id IS DISTINCT FROM OLD.co_id) THEN
    PERFORM mbbs_rebuild_co_order_lines(NEW.co_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_delivery_orders_canonical
AFTER INSERT OR UPDATE OR DELETE ON delivery_orders
FOR EACH ROW EXECUTE FUNCTION mbbs_delivery_order_canonical_trigger();

CREATE TRIGGER trg_delivery_order_lines_canonical
AFTER INSERT OR UPDATE OR DELETE ON delivery_order_lines
FOR EACH ROW EXECUTE FUNCTION mbbs_delivery_line_canonical_trigger();

CREATE TRIGGER trg_receiving_orders_canonical
AFTER INSERT OR UPDATE OR DELETE ON receiving_orders
FOR EACH ROW EXECUTE FUNCTION mbbs_receiving_order_canonical_trigger();

CREATE TRIGGER trg_receiving_order_lines_canonical
AFTER INSERT OR UPDATE OR DELETE ON receiving_order_lines
FOR EACH ROW EXECUTE FUNCTION mbbs_receiving_line_canonical_trigger();

CREATE TRIGGER trg_local_co_orders_canonical
AFTER INSERT OR UPDATE OR DELETE ON local_co_orders
FOR EACH ROW EXECUTE FUNCTION mbbs_co_order_canonical_trigger();

CREATE TRIGGER trg_local_co_order_lines_canonical
AFTER INSERT OR UPDATE OR DELETE ON local_co_order_lines
FOR EACH ROW EXECUTE FUNCTION mbbs_co_line_canonical_trigger();

COMMENT ON TABLE sales_orders IS 'Physical canonical sales order table. Legacy delivery_orders writes are mirrored by triggers during repository migration.';
COMMENT ON TABLE transfer_orders IS 'Physical canonical transfer order table combining outbound and receiving state. Legacy delivery_orders/receiving_orders writes are mirrored by triggers.';
COMMENT ON TABLE purchase_orders IS 'Physical canonical purchase order table. Legacy receiving_orders writes are mirrored by triggers during repository migration.';
COMMENT ON TABLE co_orders IS 'Physical canonical local transit order table. Legacy local_co_orders writes are mirrored by triggers during repository migration.';
