-- Schema-only rollback is deliberately unavailable once operational evidence exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sales_order_line_sync_holds) THEN
    RAISE EXCEPTION 'Retain local hold audit records; release the individual hold instead';
  END IF;
END $$;
DROP TRIGGER preserve_held_sales_order_line_source ON sales_order_lines;
DROP FUNCTION preserve_held_sales_order_line_source();
DROP TABLE sales_order_line_sync_holds;
