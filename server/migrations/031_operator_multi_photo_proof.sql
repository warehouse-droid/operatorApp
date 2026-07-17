ALTER TABLE IF EXISTS operator_load_records
  ADD COLUMN IF NOT EXISTS photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE operator_load_records
   SET photo_data_urls = jsonb_build_array(photo_data_url)
 WHERE COALESCE(photo_data_url, '') <> ''
   AND jsonb_array_length(photo_data_urls) = 0;

ALTER TABLE IF EXISTS delivery_fulfillment_records
  ADD COLUMN IF NOT EXISTS photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE delivery_fulfillment_records
   SET photo_data_urls = jsonb_build_array(photo_data_url)
 WHERE COALESCE(photo_data_url, '') <> ''
   AND jsonb_array_length(photo_data_urls) = 0;

ALTER TABLE IF EXISTS customer_pickup_load_records
  ADD COLUMN IF NOT EXISTS photo_data_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE customer_pickup_load_records
   SET photo_data_urls = jsonb_build_array(photo_data_url)
 WHERE COALESCE(photo_data_url, '') <> ''
   AND jsonb_array_length(photo_data_urls) = 0;
