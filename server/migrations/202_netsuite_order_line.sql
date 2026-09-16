-- REST orderLine is independent of the stable transaction-line unique key.
ALTER TABLE sales_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_order_line bigint
    CHECK (netsuite_order_line > 0 AND netsuite_order_line <= 9007199254740991),
  ADD COLUMN IF NOT EXISTS netsuite_order_line_synced_at timestamptz;
ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_order_line bigint
    CHECK (netsuite_order_line > 0 AND netsuite_order_line <= 9007199254740991),
  ADD COLUMN IF NOT EXISTS netsuite_order_line_synced_at timestamptz;
ALTER TABLE transfer_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_order_line bigint
    CHECK (netsuite_order_line > 0 AND netsuite_order_line <= 9007199254740991),
  ADD COLUMN IF NOT EXISTS netsuite_order_line_synced_at timestamptz;

COMMENT ON COLUMN sales_order_lines.netsuite_order_line IS
  'NetSuite REST source item line number, separate from line_id (lineuniquekey). Null means not observed.';
COMMENT ON COLUMN purchase_order_lines.netsuite_order_line IS
  'NetSuite REST source item line number, separate from line_id (lineuniquekey). Split lines retain the parent mapping.';
COMMENT ON COLUMN transfer_order_lines.netsuite_order_line IS
  'NetSuite REST visible source item line number for both outbound and receiving stages, never an accounting-row offset.';

-- Split rows use the exact source relationship, including PO children whose
-- own line_id is synthetic. These updates intentionally touch mapping only.
CREATE OR REPLACE FUNCTION refresh_netsuite_split_order_lines(p_kind text, p_source_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_kind = 'SO' THEN
    UPDATE sales_order_lines child
       SET netsuite_order_line = source.netsuite_order_line,
           netsuite_order_line_synced_at = source.netsuite_order_line_synced_at
      FROM dispatch_scm_so_splits split
      JOIN sales_order_lines source ON source.sales_order_id = split.source_so_id
     WHERE split.source_so_id = p_source_id AND split.status = 'active'
       AND child.sales_order_id = split.split_so_id
       AND child.line_id = source.line_id AND child.item_id = source.item_id
       AND (child.netsuite_order_line, child.netsuite_order_line_synced_at)
           IS DISTINCT FROM (source.netsuite_order_line, source.netsuite_order_line_synced_at);
  ELSIF p_kind = 'PO' THEN
    UPDATE purchase_order_lines child
       SET netsuite_order_line = source.netsuite_order_line,
           netsuite_order_line_synced_at = source.netsuite_order_line_synced_at
      FROM dispatch_scm_po_splits split
      JOIN dispatch_scm_po_split_lines ledger ON ledger.split_id = split.id
      JOIN purchase_order_lines source ON source.id = ledger.source_line_id
        AND source.purchase_order_id = split.source_po_id
     WHERE split.source_po_id = p_source_id AND split.status = 'active'
       AND child.purchase_order_id = split.split_po_id AND child.id = ledger.split_line_id
       AND child.item_id = source.item_id
       AND (child.netsuite_order_line, child.netsuite_order_line_synced_at)
           IS DISTINCT FROM (source.netsuite_order_line, source.netsuite_order_line_synced_at);
  ELSIF p_kind = 'TO' THEN
    UPDATE transfer_order_lines child
       SET netsuite_order_line = source.netsuite_order_line,
           netsuite_order_line_synced_at = source.netsuite_order_line_synced_at
      FROM dispatch_scm_to_splits split
      JOIN dispatch_scm_to_split_lines ledger ON ledger.split_id = split.id
      JOIN transfer_order_lines source ON source.id = ledger.source_line_id
        AND source.line_stage = ledger.source_line_stage
        AND source.transfer_order_id = split.source_to_id
     WHERE split.source_to_id = p_source_id AND split.status = 'active'
       AND child.transfer_order_id = split.split_to_id AND child.id = ledger.split_line_id
       AND child.line_stage = ledger.split_line_stage AND child.item_id = source.item_id
       AND (child.netsuite_order_line, child.netsuite_order_line_synced_at)
           IS DISTINCT FROM (source.netsuite_order_line, source.netsuite_order_line_synced_at);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION propagate_netsuite_order_line_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'sales_order_lines' THEN
    IF NEW.sales_order_id > 0 THEN PERFORM refresh_netsuite_split_order_lines('SO', NEW.sales_order_id); END IF;
  ELSIF TG_TABLE_NAME = 'purchase_order_lines' THEN
    IF NEW.purchase_order_id > 0 THEN PERFORM refresh_netsuite_split_order_lines('PO', NEW.purchase_order_id); END IF;
  ELSIF TG_TABLE_NAME = 'transfer_order_lines' THEN
    IF NEW.transfer_order_id > 0 THEN PERFORM refresh_netsuite_split_order_lines('TO', NEW.transfer_order_id); END IF;
  ELSIF TG_TABLE_NAME = 'dispatch_scm_po_split_lines' THEN
    SELECT source_po_id INTO source_id FROM dispatch_scm_po_splits WHERE id = NEW.split_id;
    PERFORM refresh_netsuite_split_order_lines('PO', source_id);
  ELSIF TG_TABLE_NAME = 'dispatch_scm_to_split_lines' THEN
    SELECT source_to_id INTO source_id FROM dispatch_scm_to_splits WHERE id = NEW.split_id;
    PERFORM refresh_netsuite_split_order_lines('TO', source_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inherit_sales_split_order_line_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sales_order_id < 0 THEN
    SELECT source.netsuite_order_line, source.netsuite_order_line_synced_at
      INTO NEW.netsuite_order_line, NEW.netsuite_order_line_synced_at
      FROM dispatch_scm_so_splits split
      JOIN sales_order_lines source ON source.sales_order_id = split.source_so_id
     WHERE split.split_so_id = NEW.sales_order_id AND split.status = 'active'
       AND source.line_id = NEW.line_id AND source.item_id = NEW.item_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inherit_sales_split_order_line_mapping ON sales_order_lines;
CREATE TRIGGER inherit_sales_split_order_line_mapping
  BEFORE INSERT OR UPDATE OF sales_order_id, line_id, item_id ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION inherit_sales_split_order_line_mapping();

DO $$ DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sales_order_lines', 'purchase_order_lines', 'transfer_order_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS propagate_netsuite_order_line_mapping ON %I', table_name);
    EXECUTE format('CREATE TRIGGER propagate_netsuite_order_line_mapping
      AFTER INSERT OR UPDATE OF netsuite_order_line, netsuite_order_line_synced_at ON %I
      FOR EACH ROW EXECUTE FUNCTION propagate_netsuite_order_line_mapping()', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['dispatch_scm_po_split_lines', 'dispatch_scm_to_split_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS propagate_netsuite_order_line_mapping ON %I', table_name);
    EXECUTE format('CREATE TRIGGER propagate_netsuite_order_line_mapping
      AFTER INSERT OR UPDATE OF source_line_id, split_line_id, split_id ON %I
      FOR EACH ROW EXECUTE FUNCTION propagate_netsuite_order_line_mapping()', table_name);
  END LOOP;
END;
$$;
