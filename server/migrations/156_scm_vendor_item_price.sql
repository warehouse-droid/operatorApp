ALTER TABLE scm_netsuite_vendor_item_codes
  ADD COLUMN IF NOT EXISTS vendor_price numeric,
  ADD COLUMN IF NOT EXISTS vendor_price_synced_at timestamptz;

COMMENT ON COLUMN scm_netsuite_vendor_item_codes.vendor_price IS
  'NetSuite Item Vendor purchaseprice for this exact vendor, item, and subsidiary. Zero or NULL is not a usable price and falls back to Item Last Purchase Price.';

COMMENT ON COLUMN scm_netsuite_vendor_item_codes.vendor_price_synced_at IS
  'Time the vendor-specific purchase price was checked in NetSuite, including checks that returned an empty or zero price.';
