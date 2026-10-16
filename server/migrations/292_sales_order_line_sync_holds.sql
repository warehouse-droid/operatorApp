-- Local exceptions retain an exact source line while Operator progress continues.
CREATE TABLE IF NOT EXISTS sales_order_line_sync_holds (
  sales_order_line_id bigint PRIMARY KEY REFERENCES sales_order_lines(id),
  source_snapshot jsonb NOT NULL,
  before_state jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text,
  CHECK (jsonb_typeof(source_snapshot) = 'object'),
  CHECK (source_snapshot ?& ARRAY['id','sales_order_id','line_id','quantity','unit']),
  CHECK ((source_snapshot->>'id')::bigint = sales_order_line_id),
  CHECK ((source_snapshot - ARRAY['id','sales_order_id','line_id','item_id','item_name','sku',
    'item_description','item_type','item_type_text','quantity','unit','pallet_qty','layer_qty',
    'section_qty','piece_qty','to_plt','to_lyr','to_sec','to_pcs','netsuite_active','sync_exception',
    'synced_at','location_id','location','item_weight','sync_exception_at','netsuite_committed_qty',
    'netsuite_backordered_qty','pack_quantity_source','netsuite_order_line','netsuite_order_line_synced_at']) = '{}'::jsonb),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);

COMMENT ON TABLE sales_order_line_sync_holds IS
  'Audited local source-line exceptions. Release the hold explicitly before allowing NetSuite to replace its values. Operator packing/loading fields are not source snapshots.';

CREATE OR REPLACE FUNCTION preserve_held_sales_order_line_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held_source jsonb;
  sync_write boolean;
BEGIN
  SELECT source_snapshot INTO held_source
    FROM sales_order_line_sync_holds
   WHERE sales_order_line_id = OLD.id AND released_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;

  sync_write := NEW.synced_at IS DISTINCT FROM OLD.synced_at
    OR NEW.netsuite_order_line_synced_at IS DISTINCT FROM OLD.netsuite_order_line_synced_at;
  NEW := jsonb_populate_record(NEW, held_source);
  -- The sync upsert also projects remote fulfillment into loaded quantities.
  -- Preserve those on sync writes; ordinary local loading remains writable.
  IF sync_write THEN
    NEW.loaded_qty := OLD.loaded_qty;
    NEW.loaded_uom := OLD.loaded_uom;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_held_sales_order_line_source ON sales_order_lines;
CREATE TRIGGER preserve_held_sales_order_line_source
BEFORE UPDATE ON sales_order_lines
FOR EACH ROW EXECUTE FUNCTION preserve_held_sales_order_line_source();
