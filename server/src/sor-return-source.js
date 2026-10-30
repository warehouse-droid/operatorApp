import crypto from 'node:crypto';

function sorted(value) {
  if (Array.isArray(value)) {return value.map(sorted);}
  if (!value || typeof value !== 'object') {return value;}
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}

/** Compare source content independently of PostgreSQL JSON key ordering. */
export function sorReturnSourceFingerprint(draft) {
  if (!draft) {return '';}
  const normalized = {...draft, parentSalesOrderId: String(draft.parentSalesOrderId ?? ''),
    weightLbs: Number(draft.weightLbs || 0), salesQty: Number(draft.salesQty || 0),
    lineSnapshot: draft.lineSnapshot.map(line => ({...line, unit: String(line.unit ?? '')}))};
  return crypto.createHash('sha256').update(JSON.stringify(sorted(normalized))).digest('hex');
}

export function sorStoredReturnDraft(row) {
  return {refNumber: row.ref_number, parentOrderRef: row.parent_order_ref, parentSalesOrderId: row.parent_sales_order_id,
    pickupLocation: row.pickup_location, dropoffLocation: row.dropoff_location, expectedDeliveryDate: '',
    lineSnapshot: row.line_snapshot, orderDetails: row.order_details, weightLbs: row.weight_lbs,
    salesQty: row.sales_qty, customer: row.sor_customer};
}
