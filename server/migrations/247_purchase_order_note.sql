-- Preserve the actual NetSuite Note (custbody7) separately from the Remark and
-- parsed pickup instructions. NULL means an older sync has not read it yet.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS netsuite_note text;
