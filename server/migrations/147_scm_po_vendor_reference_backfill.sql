-- Before NetSuite PO History had a dedicated Vendor reference, non-split POs
-- stored the same operator-entered value in dispatch_ref. Preserve that value
-- without treating real PO split identities as vendor references.
UPDATE purchase_orders po
   SET vendor_reference = BTRIM(po.dispatch_ref)
 WHERE COALESCE(BTRIM(po.vendor_reference), '') = ''
   AND COALESCE(BTRIM(po.dispatch_ref), '') <> ''
   AND NOT EXISTS (
     SELECT 1
       FROM dispatch_scm_po_splits split_record
      WHERE split_record.split_po_id = po.netsuite_id
   );

-- Dispatch, PO Split, and PO/TO Schedule all read the schedule's
-- packing_slip_ref. Backfill only an empty value and retain route/status data.
UPDATE scm_transport_schedule schedule
   SET source_table = 'purchase_orders',
       source_id = po.netsuite_id,
       packing_slip_ref = po.vendor_reference,
       updated_by = COALESCE(NULLIF(schedule.updated_by, ''), 'vendor-reference-backfill'),
       updated_at = now()
  FROM purchase_orders po
 WHERE schedule.order_kind = 'PO'
   AND COALESCE(BTRIM(schedule.packing_slip_ref), '') = ''
   AND COALESCE(BTRIM(po.vendor_reference), '') <> ''
   AND NOT EXISTS (
     SELECT 1
       FROM dispatch_scm_po_splits split_record
      WHERE split_record.split_po_id = po.netsuite_id
   )
   AND (
     (schedule.source_table = 'purchase_orders' AND schedule.source_id = po.netsuite_id)
     OR LOWER(BTRIM(schedule.order_ref)) = LOWER(BTRIM(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)))
   );
