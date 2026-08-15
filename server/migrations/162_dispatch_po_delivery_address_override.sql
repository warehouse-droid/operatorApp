ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS dispatch_delivery_address text NOT NULL DEFAULT '';

COMMENT ON COLUMN purchase_orders.dispatch_delivery_address IS
  'Optional dispatcher-entered PO delivery/drop address. Blank uses the mapped destination-yard address.';

-- Before this column existed, the Dispatch PO details form wrote its delivery
-- address into dispatch_address, which is the PO vendor/pickup address. Preserve
-- those operator-entered values as delivery overrides and stop using them as
-- pickup addresses.
UPDATE purchase_orders
   SET dispatch_delivery_address = dispatch_address,
       dispatch_address = COALESCE(NULLIF(BTRIM(vendor_address), ''), '')
 WHERE dispatch_parse_source = 'manual-dispatch-details'
   AND NULLIF(BTRIM(dispatch_delivery_address), '') IS NULL
   AND NULLIF(BTRIM(dispatch_address), '') IS NOT NULL;
