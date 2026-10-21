DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sales_special_stock_lines line
    JOIN sales_stock_requests request ON request.id=line.request_id
    JOIN sales_special_stock_cases special ON special.request_id=line.request_id
    LEFT JOIN inventory_items item ON item.item_id=line.regular_item_id
    WHERE special.workflow_kind='backorder' AND (
      line.backorder_destination_location_id IS DISTINCT FROM request.destination_location_id
      OR line.backorder_vendor_id IS DISTINCT FROM COALESCE(line.response_vendor_id,item.vendor_id,special.vendor_id)
    )
  ) THEN RAISE EXCEPTION 'Rollback refused: independent Backorder routes would be lost.'; END IF;
END $$;
DROP TRIGGER IF EXISTS backorder_route_defaults ON sales_special_stock_lines;
DROP FUNCTION IF EXISTS default_backorder_line_route();
ALTER TABLE sales_special_stock_lines DROP COLUMN backorder_destination_location_id;
ALTER TABLE sales_special_stock_lines DROP COLUMN backorder_vendor_id;
