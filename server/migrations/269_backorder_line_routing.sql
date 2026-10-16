ALTER TABLE sales_special_stock_lines ADD COLUMN backorder_vendor_id bigint
  CHECK (backorder_vendor_id IS NULL OR backorder_vendor_id > 0);
ALTER TABLE sales_special_stock_lines ADD COLUMN backorder_destination_location_id bigint
  CHECK (backorder_destination_location_id IS NULL OR backorder_destination_location_id IN (1,28,15,26));

UPDATE sales_special_stock_lines line
SET backorder_destination_location_id=request.destination_location_id,
    backorder_vendor_id=COALESCE(line.response_vendor_id,item.vendor_id,special.vendor_id)
FROM sales_special_stock_cases special,sales_stock_requests request,inventory_items item
WHERE special.request_id=line.request_id AND request.id=line.request_id
  AND item.item_id=line.regular_item_id AND special.workflow_kind='backorder';

CREATE FUNCTION default_backorder_line_route() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.regular_item_id IS NOT NULL AND NEW.backorder_destination_location_id IS NULL THEN
    SELECT request.destination_location_id,
           COALESCE(NEW.backorder_vendor_id,NEW.response_vendor_id,item.vendor_id,special.vendor_id)
    INTO NEW.backorder_destination_location_id,NEW.backorder_vendor_id
    FROM sales_stock_requests request
    JOIN sales_special_stock_cases special ON special.request_id=request.id
    JOIN inventory_items item ON item.item_id=NEW.regular_item_id
    WHERE request.id=NEW.request_id AND special.workflow_kind='backorder';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER backorder_route_defaults BEFORE INSERT ON sales_special_stock_lines
FOR EACH ROW EXECUTE FUNCTION default_backorder_line_route();
