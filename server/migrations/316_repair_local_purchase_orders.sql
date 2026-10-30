-- Local repair purchase orders share the purchase/receipt identity used by invoices.
ALTER TABLE repair_purchases DROP CONSTRAINT repair_purchases_status_check;
ALTER TABLE repair_purchases ADD CONSTRAINT repair_purchases_status_check CHECK(status IN ('ordered','draft','completed'));
DROP INDEX repair_purchase_supplier_invoice;
CREATE UNIQUE INDEX repair_purchase_supplier_invoice ON repair_purchases(vendor_id,lower(btrim(invoice_ref))) WHERE btrim(invoice_ref)<>'';
ALTER TABLE repair_purchases ADD CONSTRAINT repair_purchase_invoice_required CHECK(btrim(invoice_ref)<>'' OR (status='ordered' AND coalesce(data->>'poNumber','')<>''));
CREATE SEQUENCE repair_local_po_number_seq;
CREATE UNIQUE INDEX repair_local_po_number ON repair_purchases((data->>'poNumber')) WHERE data ? 'poNumber';
