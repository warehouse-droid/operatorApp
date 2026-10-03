ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS expires_on date;
UPDATE sales_special_stock_cases special
   SET expires_on = ((request.created_at AT TIME ZONE 'America/Toronto')::date + interval '1 month')::date
  FROM sales_stock_requests request WHERE request.id=special.request_id AND special.expires_on IS NULL;
ALTER TABLE sales_special_stock_cases ALTER COLUMN expires_on SET NOT NULL;
ALTER TABLE sales_special_stock_cases ALTER COLUMN expires_on SET DEFAULT (((now() AT TIME ZONE 'America/Toronto')::date + interval '1 month')::date);
ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS order_customer_netsuite_id bigint;
ALTER TABLE sales_special_stock_cases ADD COLUMN IF NOT EXISTS order_customer_name text;
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS detail_spec text NOT NULL DEFAULT '';
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS pack_pallet_qty numeric CHECK (pack_pallet_qty >= 0 AND pack_pallet_qty <= 1000000000);
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS pack_layer_qty numeric CHECK (pack_layer_qty >= 0 AND pack_layer_qty <= 1000000000);
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS pack_section_qty numeric CHECK (pack_section_qty >= 0 AND pack_section_qty <= 1000000000);
ALTER TABLE sales_special_stock_lines ADD COLUMN IF NOT EXISTS pack_piece_qty numeric CHECK (pack_piece_qty >= 0 AND pack_piece_qty <= 1000000000);
ALTER TABLE sales_special_stock_order_lines ADD COLUMN IF NOT EXISTS pack_pallet_qty numeric CHECK (pack_pallet_qty >= 0 AND pack_pallet_qty <= 1000000000);
ALTER TABLE sales_special_stock_order_lines ADD COLUMN IF NOT EXISTS pack_layer_qty numeric CHECK (pack_layer_qty >= 0 AND pack_layer_qty <= 1000000000);
ALTER TABLE sales_special_stock_order_lines ADD COLUMN IF NOT EXISTS pack_section_qty numeric CHECK (pack_section_qty >= 0 AND pack_section_qty <= 1000000000);
ALTER TABLE sales_special_stock_order_lines ADD COLUMN IF NOT EXISTS pack_piece_qty numeric CHECK (pack_piece_qty >= 0 AND pack_piece_qty <= 1000000000);
CREATE INDEX IF NOT EXISTS special_case_expiry_open_idx ON sales_special_stock_cases(expires_on,request_id)
 WHERE close_status='active' AND sales_order_netsuite_id IS NULL AND purchase_order_netsuite_id IS NULL;
CREATE INDEX IF NOT EXISTS special_request_owner_yard_idx ON sales_stock_requests(requested_by,destination_location_id,id) WHERE request_type='special';
