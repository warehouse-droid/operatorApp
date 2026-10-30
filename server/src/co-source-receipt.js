import { query, withTransaction } from './db.js';
import { lockConsolidatedLoadOrders } from './consolidation-load-locks.js';
import { assertNoActiveOperatorNetSuitePostingClaims } from './operator-netsuite-posting-repository.js';
import { assertNoClosedNetSuiteOrders } from './netsuite-closed-order-repository.js';
import { operatorRoundedSalesQuantity } from './operator-load-quantity.js';
import { writeAudit } from './auth-repository.js';

const RECEIVED_FIELDS = ['received_pallet_qty', 'received_layer_qty', 'received_section_qty', 'received_piece_qty', 'received_sales_qty'];
const PACKED_FIELDS = ['packed_pallet_qty', 'packed_layer_qty', 'packed_section_qty', 'packed_piece_qty', 'packed_sales_qty'];
const CONVERSIONS = ['to_plt', 'to_lyr', 'to_sec', 'to_pcs'];
const quantity = value => Math.max(0, Number(value) || 0);
const receiptError = message => Object.assign(new Error(message), { status: 409, code: 'CO_SOURCE_RECEIPT_CONFLICT' });

export function withCoReceivingMutation(coRefOrId, operation) {
  return withTransaction(async () => {
    const co = (await query(`SELECT delivery_order_id FROM local_co_orders
      WHERE co_ref=$1 OR delivery_order_id::text=$1 OR id::text=$1`, [String(coRefOrId)])).rows[0];
    if (co) {await lockConsolidatedLoadOrders([co.delivery_order_id]);}
    return operation();
  });
}

function receivedSales(line) {
  return CONVERSIONS.some(field => quantity(line[field]) > 0)
    ? operatorRoundedSalesQuantity(CONVERSIONS.reduce((sum, field, index) =>
      sum + quantity(line[field]) * quantity(line[RECEIVED_FIELDS[index]]), 0), line.unit)
    : quantity(line.received_sales_qty);
}

function receiptUpdates(cargo, sourceLines) {
  const updates = new Map();
  for (const line of cargo) {
    if (!RECEIVED_FIELDS.some(field => quantity(line[field]) > 0)) {continue;}
    const sourceId = line.raw?.lineRowId ?? line.raw?.line_row_id;
    const matches = sourceLines.filter(source => String(source.item_id) === String(line.item_id)
      && (sourceId ? String(source.id) === String(sourceId) : String(source.line_id) === String(line.line_id)));
    if (matches.length !== 1) {throw receiptError(`Cannot identify the original sales line for ${line.sku || line.item_name}.`);}
    const source = matches[0];
    if (quantity(source.loaded_qty) > 0 || ['fulfilled_pallet_qty', 'fulfilled_layer_qty', 'fulfilled_section_qty', 'fulfilled_piece_qty']
      .some(field => quantity(source[field]) > 0)) {throw receiptError('The source sales line has already been loaded.');}
    const sales = receivedSales(line);
    if (sales > quantity(line.quantity) + 0.000001) {throw receiptError('Received quantity exceeds the CO cargo.');}
    const next = updates.get(String(source.id)) || { source, values: RECEIVED_FIELDS.map(() => 0), sales: 0 };
    next.values = next.values.map((value, index) => value + quantity(line[RECEIVED_FIELDS[index]]));
    next.sales += sales;
    if (next.sales > quantity(source.quantity) + 0.000001) {throw receiptError('Received quantity exceeds the original sales line.');}
    updates.set(String(source.id), next);
  }
  if (!updates.size) {throw receiptError('No confirmed CO lines to receive.');}
  return [...updates.values()];
}

async function saveReceipt(co, orders, updates, operatorId, photos) {
  for (const { source, values } of updates) {
    await query(`UPDATE sales_order_lines SET ${PACKED_FIELDS.map((field, index) => `${field}=$${index + 2}`).join(',')},
      confirmed=true,confirmed_at=now() WHERE id=$1`, [source.id, ...values]);
  }
  const affectedIds = [...new Set(updates.map(update => update.source.sales_order_id))];
  await query(`UPDATE sales_orders SET operator_status='packed',local_yard_order_status='Open',
    preparing_operator_id=NULL,preparing_started_at=NULL,status_updated_at=now()
    WHERE netsuite_id=ANY($1::bigint[])`, [affectedIds]);
  await query(`UPDATE co_orders SET status='received',received_at=now(),received_by=$2,updated_at=now()
    WHERE id=$1`, [co.id, operatorId || null]);
  const deliveryOrderId = orders.length === 1 ? Number(orders[0].netsuite_id) : `GROUP:${co.source_order_ref}`;
  const response = { receiptStatus: 'local_co_received', itemReceiptTranid: co.co_ref, deliveryOrderId,
    sourceDeliveryOrderIds: affectedIds, localYardOrderStatus: 'Packed' };
  await query(`INSERT INTO local_co_receipt_records(co_id,operator_id,photo_data_urls,created_delivery_order_id,response)
    VALUES($1,$2,$3::jsonb,$4,$5::jsonb)`,
  [co.id, operatorId || null, JSON.stringify(photos), orders.length === 1 ? deliveryOrderId : null, JSON.stringify(response)]);
  await writeAudit({ actorOperatorId: operatorId, source: 'receiving', action: 'local_co.order.receive',
    orderId: co.delivery_order_id, details: { coRef: co.co_ref, sourceOrderRef: co.source_order_ref,
      revivedSourceSalesOrder: true, sourceDeliveryOrderIds: affectedIds, destinationLocation: co.to_location,
      lines: updates.map(update => ({ sourceLineId: update.source.id, packed: update.values })) } });
  return response;
}

// Return null for non-sales/legacy sources so their established receipt path continues.
export async function receiveCoSourceSalesOrders(coRefOrId, operatorId, photos) {
  return withTransaction(async () => {
    const initial = (await query(`SELECT * FROM local_co_orders
      WHERE co_ref=$1 OR delivery_order_id::text=$1 OR id::text=$1`, [String(coRefOrId)])).rows[0];
    if (!initial) {return null;}
    const refs = [...new Set([initial.source_order_ref, ...(initial.details?.childOrderIds || [])])];
    const orders = (await query('SELECT * FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id', [refs])).rows;
    if (!orders.length) {return null;}
    await lockConsolidatedLoadOrders([initial.delivery_order_id, ...orders.map(order => order.netsuite_id)]);
    const co = (await query('SELECT * FROM local_co_orders WHERE id=$1 FOR UPDATE', [initial.id])).rows[0];
    if (!co || !['planned', 'completed'].includes(co.status) || co.received_at) {throw receiptError('This CO is not ready for receiving.');}
    await assertNoClosedNetSuiteOrders(orders.map(order => order.tranid), 'receive CO cargo for its source sales orders');
    await assertNoActiveOperatorNetSuitePostingClaims({ functionKey: 'delivery_prep',
      localOrderKeys: orders.map(order => `delivery_prep:sales_order:${order.netsuite_id}`) });
    const sourceLines = (await query(`SELECT line.* FROM sales_order_lines line
      WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [orders.map(order => order.netsuite_id)])).rows;
    const cargo = (await query('SELECT * FROM co_order_lines WHERE co_id=$1 ORDER BY line_id,id FOR UPDATE', [co.id])).rows;
    return saveReceipt(co, orders, receiptUpdates(cargo, sourceLines), operatorId, photos);
  });
}
